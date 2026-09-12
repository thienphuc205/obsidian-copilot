import { redactSensitivePayload, wrapStreamsForDebug } from "./debugTap";

const mockLogInfo = jest.fn();
const mockFrameAppend = jest.fn();
let mockDebugFullFrames = false;

jest.mock("@/logger", () => ({
  logInfo: (...args: unknown[]) => mockLogInfo(...args),
}));

jest.mock("@/settings/model", () => ({
  getSettings: () => ({ agentMode: { debugFullFrames: mockDebugFullFrames } }),
}));

jest.mock("@/agentMode/session/debugSink", () => ({
  formatPayload: (value: unknown) => JSON.stringify(value),
  frameSink: { append: (...args: unknown[]) => mockFrameAppend(...args) },
}));

const TOKEN = "bridge-token-sentinel";

function makeWritable(chunks: Uint8Array[]): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk);
    },
  });
}

async function writeAndClose(stream: WritableStream<Uint8Array>, line: string): Promise<void> {
  const writer = stream.getWriter();
  await writer.write(new TextEncoder().encode(line));
  await writer.close();
}

function sinkOutput(): string {
  return `${JSON.stringify(mockLogInfo.mock.calls)}${JSON.stringify(mockFrameAppend.mock.calls)}`;
}

beforeEach(() => {
  mockDebugFullFrames = false;
  mockLogInfo.mockClear();
  mockFrameAppend.mockClear();
});

describe("debugTap secret redaction", () => {
  it("clones and redacts headers, env tokens, and token arguments without changing live payloads", () => {
    const payload = {
      params: {
        mcpServers: [
          {
            headers: [{ name: "Authorization", value: `Bearer ${TOKEN}` }],
          },
        ],
        env: { COPILOT_WEB_BRIDGE_TOKEN: TOKEN, COPILOT_PLUS_LICENSE_KEY: TOKEN },
        args: ["--token", TOKEN],
        query: "vault note text stays intact",
      },
    };

    const redacted = redactSensitivePayload(payload);

    expect(JSON.stringify(redacted)).not.toContain(TOKEN);
    expect((redacted as { params: { query: string } }).params.query).toBe(
      "vault note text stays intact"
    );
    expect(
      (redacted as { params: { env: { COPILOT_PLUS_LICENSE_KEY: string } } }).params.env
        .COPILOT_PLUS_LICENSE_KEY
    ).toBe("<redacted>");
    expect(payload.params.mcpServers[0].headers[0].value).toBe(`Bearer ${TOKEN}`);
    expect(payload.params.env.COPILOT_WEB_BRIDGE_TOKEN).toBe(TOKEN);
    expect(payload.params.args[1]).toBe(TOKEN);
  });

  it("redacts parsed full frames before both logger and frame sinks while preserving bytes", async () => {
    mockDebugFullFrames = true;
    const chunks: Uint8Array[] = [];
    const rawLine =
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "session/new",
          params: {
            mcpServers: [
              {
                type: "http",
                headers: [{ name: "Authorization", value: `Bearer ${TOKEN}` }],
              },
            ],
            env: { COPILOT_WEB_BRIDGE_TOKEN: TOKEN, COPILOT_PLUS_LICENSE_KEY: TOKEN },
            args: ["--token", TOKEN],
            query: "vault note text",
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { headers: [{ name: "Authorization", value: TOKEN }] },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          error: { code: -32000, message: `provider rejected Bearer ${TOKEN}` },
        }),
      ].join("\n") + "\n";
    const wrapped = wrapStreamsForDebug(makeWritable(chunks), new ReadableStream(), "codex");

    await writeAndClose(wrapped.stdin, rawLine);

    expect(sinkOutput()).not.toContain(TOKEN);
    expect(new TextDecoder().decode(chunks[0])).toBe(rawLine);
    expect(mockFrameAppend).toHaveBeenCalledTimes(3);
  });

  it("redacts active literal credentials in arbitrary error text without mutating bytes", async () => {
    mockDebugFullFrames = true;
    const chunks: Uint8Array[] = [];
    const rawLine =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32000, message: `provider echoed ${TOKEN}` },
      }) + "\n";
    const wrapped = wrapStreamsForDebug(makeWritable(chunks), new ReadableStream(), "codex", [
      TOKEN,
    ]);

    await writeAndClose(wrapped.stdin, rawLine);

    expect(sinkOutput()).not.toContain(TOKEN);
    expect(new TextDecoder().decode(chunks[0])).toBe(rawLine);
    expect(mockFrameAppend).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { code: -32000, message: expect.not.stringContaining(TOKEN) },
      })
    );
  });

  it("redacts malformed raw ACP lines before both logger and frame sinks", async () => {
    mockDebugFullFrames = true;
    const chunks: Uint8Array[] = [];
    const rawLine =
      `not-json Authorization: ${TOKEN} token=${TOKEN} Bearer ${TOKEN} ` +
      `COPILOT_PLUS_LICENSE_KEY=${TOKEN}\n`;
    const wrapped = wrapStreamsForDebug(makeWritable(chunks), new ReadableStream(), "codex");

    await writeAndClose(wrapped.stdin, rawLine);

    expect(sinkOutput()).not.toContain(TOKEN);
    expect(new TextDecoder().decode(chunks[0])).toBe(rawLine);
    expect(mockFrameAppend).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "raw", payload: { raw: expect.not.stringContaining(TOKEN) } })
    );
  });
});
