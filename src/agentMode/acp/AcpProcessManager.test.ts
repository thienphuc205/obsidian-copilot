import { requireNodeModule } from "@/utils/desktopRuntime";
import { AcpProcessManager, sanitizeAcpStdout } from "@/agentMode/acp/AcpProcessManager";

const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();
const mockLogError = jest.fn();

jest.mock("@/logger", () => ({
  logInfo: (...args: unknown[]) => mockLogInfo(...args),
  logWarn: (...args: unknown[]) => mockLogWarn(...args),
  logError: (...args: unknown[]) => mockLogError(...args),
}));

jest.mock("@/utils/desktopRuntime", () => ({
  requireNodeModule: jest.fn(),
}));

/** The exact prefix reported in the opencode hang (two OSC title writes). */
const OSC_TITLES = "\x1b]0;opencode: ready\x07\x1b]0;second-brain: ready\x07";
const ENVELOPE = '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function readLines(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text.split("\n").filter((line) => line.length > 0);
}

describe("AcpProcessManager", () => {
  beforeEach(() => {
    mockLogInfo.mockClear();
    mockLogWarn.mockClear();
    mockLogError.mockClear();
  });

  describe("AcpProcessManager", () => {
    describe("start()", () => {
      it("returns a stdout stream with the child's terminal escape sequences already stripped (https://github.com/logancyang/obsidian-copilot/issues/2876)", async () => {
        const identity = <T>(value: T): T => value;
        const child = {
          stdin: {},
          // `toWeb` is the identity below, so the manager receives this as-is.
          stdout: streamOf([`${OSC_TITLES}${ENVELOPE}\n`]),
          stderr: { setEncoding: jest.fn(), on: jest.fn() },
          on: jest.fn(),
        };
        (requireNodeModule as jest.Mock).mockImplementation((id: string) =>
          id === "child_process"
            ? { spawn: () => child }
            : { Readable: { toWeb: identity }, Writable: { toWeb: identity } }
        );
        const manager = new AcpProcessManager({ command: "/bin/agent", args: ["acp"], env: {} });

        const { stdout } = manager.start();

        expect(await readLines(stdout)).toEqual([ENVELOPE]);
      });

      it("redacts fragmented stderr before every logger sink without changing child chunks", () => {
        const token = "stderr-bridge-token-sentinel";
        const firstFragment = token.slice(0, 12);
        const secondFragment = token.slice(12);
        const chunks = [
          `info provider echoed ${firstFragment}`,
          `${secondFragment}\nwarn token=${firstFragment}`,
          `${secondFragment}\nfatal COPILOT_WEB_BRIDGE_TOKEN=${firstFragment}`,
          secondFragment,
        ];
        const handlers: Record<string, (chunk?: string) => void> = {};
        const stderr = {
          setEncoding: jest.fn(),
          on: jest.fn((event: string, listener: (chunk?: string) => void): void => {
            handlers[event] = listener;
          }),
        };
        const child = {
          stdin: {},
          stdout: streamOf([]),
          stderr,
          on: jest.fn(),
        };
        (requireNodeModule as jest.Mock).mockImplementation((id: string) =>
          id === "child_process"
            ? { spawn: () => child }
            : {
                Readable: { toWeb: <T>(value: T): T => value },
                Writable: { toWeb: <T>(value: T): T => value },
              }
        );
        const manager = new AcpProcessManager({
          command: "/bin/agent",
          args: [],
          env: {},
          redactionSecrets: [token],
        });

        manager.start();
        for (const chunk of chunks) handlers.data?.(chunk);
        handlers.end?.();

        const logs = JSON.stringify({
          info: mockLogInfo.mock.calls,
          warn: mockLogWarn.mock.calls,
          error: mockLogError.mock.calls,
        });
        expect(logs).not.toContain(token);
        expect(logs).toContain("<redacted>");
        expect(mockLogInfo).toHaveBeenCalled();
        expect(mockLogWarn).toHaveBeenCalled();
        expect(mockLogError).toHaveBeenCalled();
        expect(chunks.join("")).toBe(
          `info provider echoed ${token}\nwarn token=${token}\nfatal COPILOT_WEB_BRIDGE_TOKEN=${token}`
        );
      });

      it("redacts subprocess errors before logging without mutating the live error", () => {
        const token = "spawn-error-token-sentinel";
        let errorHandler: ((error: Error) => void) | undefined;
        const child = {
          stdin: {},
          stdout: streamOf([]),
          stderr: { setEncoding: jest.fn(), on: jest.fn() },
          on: jest.fn((event: string, listener: (error: Error) => void) => {
            if (event === "error") errorHandler = listener;
          }),
        };
        (requireNodeModule as jest.Mock).mockImplementation((id: string) =>
          id === "child_process"
            ? { spawn: () => child }
            : {
                Readable: { toWeb: <T>(value: T): T => value },
                Writable: { toWeb: <T>(value: T): T => value },
              }
        );
        const manager = new AcpProcessManager({
          command: "/bin/agent",
          args: [],
          env: {},
          redactionSecrets: [token],
        });
        manager.start();

        const rawError = Object.assign(new Error(`spawn failed ${token}`), {
          code: "EACCES",
          data: { echoed: token },
        });
        errorHandler?.(rawError);

        const loggedError = mockLogError.mock.calls.at(-1)?.[1] as Error & {
          code?: string;
          data?: { echoed?: string };
        };
        expect(loggedError).toBeInstanceOf(Error);
        expect(loggedError.message).not.toContain(token);
        expect(loggedError).toMatchObject({ code: "EACCES", data: { echoed: "<redacted>" } });
        expect(rawError.message).toContain(token);
        expect(rawError.data).toEqual({ echoed: token });
      });

      it("keeps the exit waiter alive through SIGKILL escalation", async () => {
        jest.useFakeTimers();
        try {
          const handlers = new Map<string, (...args: unknown[]) => void>();
          const child = {
            stdin: {},
            stdout: streamOf([]),
            stderr: { setEncoding: jest.fn(), on: jest.fn() },
            kill: jest.fn((signal: NodeJS.Signals) => {
              if (signal === "SIGKILL") handlers.get("exit")?.(0, null);
            }),
            on: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
              handlers.set(event, listener);
            }),
          };
          (requireNodeModule as jest.Mock).mockImplementation((id: string) =>
            id === "child_process"
              ? { spawn: () => child }
              : {
                  Readable: { toWeb: <T>(value: T): T => value },
                  Writable: { toWeb: <T>(value: T): T => value },
                }
          );
          const manager = new AcpProcessManager({ command: "/bin/agent", args: [], env: {} });
          manager.start();

          const shuttingDown = manager.shutdown();
          await jest.advanceTimersByTimeAsync(3_000);
          await shuttingDown;

          expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
          expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
          expect((manager as unknown as { exitListeners: Set<unknown> }).exitListeners.size).toBe(
            0
          );
        } finally {
          jest.useRealTimers();
        }
      });

      it("removes exit listeners and sends SIGTERM only once across concurrent shutdowns", async () => {
        const handlers = new Map<string, (...args: unknown[]) => void>();
        const child = {
          stdin: {},
          stdout: streamOf([]),
          stderr: { setEncoding: jest.fn(), on: jest.fn() },
          kill: jest.fn(),
          on: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
            handlers.set(event, listener);
          }),
        };
        (requireNodeModule as jest.Mock).mockImplementation((id: string) =>
          id === "child_process"
            ? { spawn: () => child }
            : {
                Readable: { toWeb: <T>(value: T): T => value },
                Writable: { toWeb: <T>(value: T): T => value },
              }
        );
        const manager = new AcpProcessManager({ command: "/bin/agent", args: [], env: {} });
        manager.start();
        const externalListener = jest.fn();
        manager.onExit(externalListener);

        const firstShutdown = manager.shutdown();
        const secondShutdown = manager.shutdown();
        handlers.get("exit")?.(0, null);
        await Promise.all([firstShutdown, secondShutdown]);

        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(externalListener).toHaveBeenCalledTimes(1);
        expect((manager as unknown as { exitListeners: Set<unknown> }).exitListeners.size).toBe(0);
      });
    });
  });

  describe("sanitizeAcpStdout()", () => {
    it("makes a frame prefixed with OSC title sequences parse as JSON (https://github.com/logancyang/obsidian-copilot/issues/2876)", async () => {
      const lines = await readLines(sanitizeAcpStdout(streamOf([`${OSC_TITLES}${ENVELOPE}\n`])));

      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: 1 },
      });
    });

    it("makes a frame prefixed with CSI sequences that use the full parameter-byte range parse as JSON (https://github.com/logancyang/obsidian-copilot/issues/2876)", async () => {
      // Truecolor uses `:` separators; `<`, `=` and `>` appear in private forms.
      const prefix = "\x1b[38:2:255:0:0m\x1b[<0;1;2M\x1b[=5h\x1b[>4;2m";

      const lines = await readLines(sanitizeAcpStdout(streamOf([`${prefix}${ENVELOPE}\n`])));

      expect(lines).toEqual([ENVELOPE]);
    });

    it("makes a frame parse as JSON when a chunk boundary splits an escape sequence (https://github.com/logancyang/obsidian-copilot/issues/2876)", async () => {
      const payload = `\x1b[32m${OSC_TITLES}${ENVELOPE}\n`;
      // Cuts land inside the CSI colour code and inside the first OSC title.
      const chunks = [payload.slice(0, 3), payload.slice(3, 12), payload.slice(12)];

      const lines = await readLines(sanitizeAcpStdout(streamOf(chunks)));

      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: 1 },
      });
    });

    it("preserves escape-free frames and their order", async () => {
      const lines = await readLines(
        sanitizeAcpStdout(streamOf(['{"a":1}\n{"b":2}\n', '{"c":3}\n']))
      );

      expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    });

    it("emits a final frame that the child left without a trailing newline", async () => {
      const lines = await readLines(sanitizeAcpStdout(streamOf([`${OSC_TITLES}${ENVELOPE}`])));

      expect(lines).toEqual([ENVELOPE]);
    });
  });
});
