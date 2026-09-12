import { request as httpRequest, type IncomingMessage } from "node:http";
import path from "node:path";
import { setImmediate as scheduleImmediate } from "node:timers";
import { WebProviderError, type WebProvider } from "@/web/types";
import { AgentWebBridgeError, startAgentWebBridge, type AgentWebBridge } from "@/web/acpWebBridge";

interface InstalledMcpTransport {
  close(): Promise<void>;
}

interface InstalledMcpClient {
  connect(transport: InstalledMcpTransport): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{
    content: Array<Record<string, unknown>>;
    structuredContent?: unknown;
  }>;
  close(): Promise<void>;
}

interface InstalledMcpClientModule {
  Client: new (clientInfo: { name: string; version: string }) => InstalledMcpClient;
}

interface InstalledMcpTransportModule {
  StreamableHTTPClientTransport: new (
    url: URL,
    options: {
      requestInit: RequestInit;
      fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
      reconnectionOptions: {
        initialReconnectionDelay: number;
        maxReconnectionDelay: number;
        reconnectionDelayGrowFactor: number;
        maxRetries: number;
      };
    }
  ) => InstalledMcpTransport;
}

// Jest's jsdom resolver selects the SDK's browser-only PKCE entry point. The
// bridge never enters OAuth, so keep that unused auth helper inert while still
// loading the installed MCP client and Streamable HTTP transport implementation.
jest.mock("pkce-challenge", () => ({
  __esModule: true,
  default: async () => ({ code_verifier: "test-verifier", code_challenge: "test-challenge" }),
}));

const { Client } = jest.requireActual<InstalledMcpClientModule>(
  path.join(process.cwd(), "node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js")
);
const { StreamableHTTPClientTransport } = jest.requireActual<InstalledMcpTransportModule>(
  path.join(
    process.cwd(),
    "node_modules/@modelcontextprotocol/sdk/dist/cjs/client/streamableHttp.js"
  )
);

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface BridgeHarness {
  bridge: AgentWebBridge;
  getProvider: jest.Mock<WebProvider | undefined, []>;
  setProvider(provider: WebProvider | undefined): void;
}

const SEARCH_RESULT = {
  kind: "web_search" as const,
  content: "A concise public-web answer.",
  sources: [
    {
      title: "Example article",
      url: "https://example.com/article",
      snippet: "A bounded snippet.",
      publishedAt: "2026-01-02",
    },
  ],
  citations: ["https://example.com/article"],
};

const FETCH_RESULT = {
  kind: "web_fetch" as const,
  url: "https://example.com/article",
  title: "Example article",
  content: "Fetched public-web content.",
  sources: SEARCH_RESULT.sources,
  citations: SEARCH_RESULT.citations,
  truncated: true,
};

describe("acpWebBridge", () => {
  jest.setTimeout(15_000);

  let harness: BridgeHarness | undefined;
  let client: InstalledMcpClient | undefined;
  let transport: InstalledMcpTransport | undefined;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
    await harness?.bridge.dispose();
    harness = undefined;
    client = undefined;
    transport = undefined;
  });

  describe("startAgentWebBridge", () => {
    it("rejects invalid configuration without exposing a runtime error", async () => {
      await expect(
        startAgentWebBridge({ getProvider: undefined as unknown as () => WebProvider })
      ).rejects.toMatchObject<Partial<AgentWebBridgeError>>({
        code: "invalid_configuration",
        message: "The web bridge configuration is invalid.",
      });
    });

    it("returns a loopback endpoint and makes disposal idempotent", async () => {
      harness = await createHarness(createProvider());

      expect(new URL(harness.bridge.url).hostname).toBe("127.0.0.1");
      expect(new URL(harness.bridge.url).pathname).toBe("/mcp");
      expect(harness.bridge.token).toHaveLength(64);

      await Promise.all([harness.bridge.dispose(), harness.bridge.dispose()]);
      await expect(
        requestRaw(harness.bridge.url, {
          method: "GET",
          headers: authenticatedHeaders(harness.bridge, { accept: "text/event-stream" }),
        })
      ).rejects.toBeDefined();
    });
  });

  describe("MCP Streamable HTTP protocol", () => {
    it("interoperates with the installed MCP client for search and fetch", async () => {
      const provider = createProvider();
      harness = await createHarness(provider);
      client = new Client({ name: "bridge-test", version: "1.0.0" });
      transport = new StreamableHTTPClientTransport(new URL(harness.bridge.url), {
        requestInit: {
          headers: { Authorization: `Bearer ${harness.bridge.token}` },
        },
        fetch: fetchForMcp,
        reconnectionOptions: {
          initialReconnectionDelay: 10,
          maxReconnectionDelay: 10,
          reconnectionDelayGrowFactor: 1,
          maxRetries: 0,
        },
      });

      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["web_search", "web_fetch"]);

      const search = await client.callTool({
        name: "web_search",
        arguments: { query: "local-first MCP", limit: 2 },
      });
      const fetched = await client.callTool({
        name: "web_fetch",
        arguments: { url: "https://example.com/article" },
      });

      expect(readTextOnlyResult(search)).toEqual(SEARCH_RESULT);
      expect(search.structuredContent).toEqual(SEARCH_RESULT);
      expect(readTextOnlyResult(fetched)).toEqual(FETCH_RESULT);
      expect(fetched.structuredContent).toEqual(FETCH_RESULT);
      expect(provider.search.mock.calls[0]?.[0]).toBe("local-first MCP");
      expect(provider.search.mock.calls[0]?.[1]).toMatchObject({ limit: 2 });
      expect(provider.search.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(provider.fetch.mock.calls[0]?.[0]).toBe("https://example.com/article");
      expect(provider.fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(provider.testConnection).not.toHaveBeenCalled();
      expect(harness.getProvider).toHaveBeenCalledTimes(3);
    });

    it("returns an empty list and a bounded disabled error without provider requests", async () => {
      harness = await createHarness(undefined);
      const sessionId = await initializeRaw(harness.bridge);

      const listed = await postRpc(
        harness.bridge,
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        sessionId
      );
      const called = await postRpc(
        harness.bridge,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "web_search", arguments: { query: "should not run" } },
        },
        sessionId
      );

      expect(JSON.parse(listed.body).result.tools).toEqual([]);
      expect(JSON.parse(called.body).result).toEqual({
        content: [{ type: "text", text: "Web tools are disabled." }],
        isError: true,
      });
      expect(harness.getProvider).toHaveBeenCalledTimes(2);
    });

    it("accepts initialized notifications and enforces MCP response media types", async () => {
      harness = await createHarness(createProvider());
      const init = await requestRaw(harness.bridge.url, {
        method: "POST",
        headers: authenticatedHeaders(harness.bridge, {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        }),
        body: JSON.stringify(initializeMessage()),
      });
      const sessionId = header(init, "mcp-session-id");
      expect(init.status).toBe(200);
      expect(header(init, "content-type")).toContain("application/json");
      expect(JSON.parse(init.body).result.protocolVersion).toBe("2025-11-25");
      expect(sessionId).toBeTruthy();

      const notification = await postRpc(
        harness.bridge,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        sessionId
      );
      expect(notification.status).toBe(202);
      expect(notification.body).toBe("");

      const missingJson = await requestRaw(harness.bridge.url, {
        method: "POST",
        headers: authenticatedHeaders(harness.bridge, {
          accept: "text/event-stream",
          "content-type": "application/json",
        }),
        body: JSON.stringify(initializeMessage()),
      });
      expect(missingJson.status).toBe(406);
    });
  });

  describe("request boundaries", () => {
    it("authenticates every route and rejects cross-origin or wrong-host requests", async () => {
      const provider = createProvider();
      harness = await createHarness(provider);
      const payload = JSON.stringify(initializeMessage());

      const missingAuth = await requestRaw(harness.bridge.url, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: payload,
      });
      const wrongToken = await requestRaw(harness.bridge.url, {
        method: "POST",
        headers: authenticatedHeaders(harness.bridge, {
          accept: "application/json",
          "content-type": "application/json",
          authorization: "Bearer wrong-token",
        }),
        body: payload,
      });
      const wrongOrigin = await requestRaw(harness.bridge.url, {
        method: "POST",
        headers: authenticatedHeaders(harness.bridge, {
          accept: "application/json",
          "content-type": "application/json",
          origin: "https://evil.example",
        }),
        body: payload,
      });
      const wrongHost = await requestRaw(harness.bridge.url, {
        method: "POST",
        headers: authenticatedHeaders(harness.bridge, {
          accept: "application/json",
          "content-type": "application/json",
          host: "localhost",
        }),
        body: payload,
      });

      expect(missingAuth.status).toBe(401);
      expect(wrongToken.status).toBe(401);
      expect(wrongOrigin.status).toBe(403);
      expect(wrongHost.status).toBe(421);
      expect(
        `${missingAuth.body}${wrongToken.body}${wrongOrigin.body}${wrongHost.body}`
      ).not.toContain(harness.bridge.token);
      expect(provider.search).not.toHaveBeenCalled();
      expect(provider.fetch).not.toHaveBeenCalled();
    });

    it("advertises the allowed methods on 405 responses", async () => {
      harness = await createHarness(createProvider());

      const response = await requestRaw(harness.bridge.url, {
        method: "GET",
        headers: authenticatedHeaders(harness.bridge, { accept: "text/event-stream" }),
      });

      expect(response.status).toBe(405);
      expect(header(response, "allow")).toBe("GET, POST, DELETE, OPTIONS");
    });

    it("rejects unknown tool fields and private URLs before provider calls", async () => {
      const provider = createProvider();
      harness = await createHarness(provider);
      const sessionId = await initializeRaw(harness.bridge);

      const unknownField = await postRpc(
        harness.bridge,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "web_search",
            arguments: { query: "valid", unexpected: "reject me" },
          },
        },
        sessionId
      );
      const privateUrl = await postRpc(
        harness.bridge,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "web_fetch", arguments: { url: "http://127.0.0.1:8080/private" } },
        },
        sessionId
      );
      const mappedPrivateUrl = await postRpc(
        harness.bridge,
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "web_fetch", arguments: { url: "http://[::ffff:7f00:1]/private" } },
        },
        sessionId
      );

      expect(JSON.parse(unknownField.body).error).toEqual({
        code: -32602,
        message: "Invalid tool parameters.",
      });
      expect(JSON.parse(privateUrl.body).error).toEqual({
        code: -32602,
        message: "Invalid tool parameters.",
      });
      expect(JSON.parse(mappedPrivateUrl.body).error).toEqual({
        code: -32602,
        message: "Invalid tool parameters.",
      });
      expect(provider.search).not.toHaveBeenCalled();
      expect(provider.fetch).not.toHaveBeenCalled();
    });

    it("sanitizes provider failures and bounds request and response bodies", async () => {
      const provider = createProvider();
      provider.search.mockRejectedValueOnce(
        new WebProviderError("unauthorized", 401, "provider secret LEAKED_SECRET", false)
      );
      harness = await createHarness(provider);
      const sessionId = await initializeRaw(harness.bridge);

      const providerError = await postRpc(
        harness.bridge,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "web_search", arguments: { query: "safe" } },
        },
        sessionId
      );
      const oversizedRequest = await requestRaw(harness.bridge.url, {
        method: "POST",
        headers: authenticatedHeaders(harness.bridge, {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        }),
        body: "x".repeat(70_000),
      });

      expect(JSON.parse(providerError.body).result).toEqual({
        content: [{ type: "text", text: "The web provider rejected the request." }],
        isError: true,
      });
      expect(providerError.body).not.toContain("LEAKED_SECRET");
      expect(providerError.body).not.toContain(harness.bridge.token);
      expect(oversizedRequest.status).toBe(413);

      provider.search.mockRejectedValueOnce(
        new WebProviderError("rate_limited", 429, "provider secret RATE_SECRET", true)
      );
      const rateLimited = await postRpc(
        harness.bridge,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "web_search", arguments: { query: "rate" } },
        },
        sessionId
      );
      expect(JSON.parse(rateLimited.body).result).toEqual({
        content: [{ type: "text", text: "The web provider rate limit was reached." }],
        isError: true,
      });
      expect(rateLimited.body).not.toContain("RATE_SECRET");

      provider.search.mockRejectedValueOnce(
        new WebProviderError("malformed_response", 200, "provider secret MALFORMED_SECRET", false)
      );
      const malformed = await postRpc(
        harness.bridge,
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "web_search", arguments: { query: "malformed" } },
        },
        sessionId
      );
      expect(JSON.parse(malformed.body).result).toEqual({
        content: [{ type: "text", text: "The web provider returned an invalid response." }],
        isError: true,
      });
      expect(malformed.body).not.toContain("MALFORMED_SECRET");

      provider.search.mockResolvedValue({ ...SEARCH_RESULT, content: "界".repeat(50_000) });
      const oversizedResponse = await postRpc(
        harness.bridge,
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "web_search", arguments: { query: "large" } },
        },
        sessionId
      );
      expect(JSON.parse(oversizedResponse.body).result).toEqual({
        content: [{ type: "text", text: "The web provider response exceeded the bridge limit." }],
        isError: true,
      });
      expect(oversizedResponse.body.length).toBeLessThan(2_000);
    });

    it("caps concurrent provider calls", async () => {
      const provider = createProvider();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      provider.search.mockImplementation(async () => {
        await gate;
        return SEARCH_RESULT;
      });
      harness = await createHarness(provider);
      const sessionId = await initializeRaw(harness.bridge);
      const calls = Array.from({ length: 5 }, (_, index) =>
        postRpc(
          harness!.bridge,
          {
            jsonrpc: "2.0",
            id: index + 10,
            method: "tools/call",
            params: { name: "web_search", arguments: { query: `query-${index}` } },
          },
          sessionId
        )
      );

      const completed = await Promise.race(calls);
      expect(JSON.parse(completed.body).result).toEqual({
        content: [{ type: "text", text: "Too many concurrent web tool calls." }],
        isError: true,
      });
      expect(provider.search).toHaveBeenCalledTimes(4);
      release();
      await Promise.all(calls);
    });
  });

  describe("lifecycle", () => {
    it("closes an idle SSE connection promptly and invalidates the session", async () => {
      harness = await createHarness(createProvider());
      const sessionId = await initializeRaw(harness.bridge);
      const streamClosed = openSse(harness.bridge, sessionId);

      await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
      const startedAt = Date.now();
      await harness.bridge.dispose();
      expect(Date.now() - startedAt).toBeLessThan(500);
      await streamClosed;
      await expect(
        postRpc(harness.bridge, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sessionId)
      ).rejects.toBeDefined();
    });

    it("returns a bounded timeout for a provider that never settles", async () => {
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      try {
        const provider = createProvider();
        let signal: AbortSignal | undefined;
        provider.search.mockImplementation((_query, options) => {
          signal = options?.signal;
          return new Promise(() => {});
        });
        harness = await createHarness(provider);
        const sessionId = await initializeRaw(harness.bridge);
        const pending = postRpc(
          harness.bridge,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "web_search", arguments: { query: "hang" } },
          },
          sessionId
        );
        await waitForMockCall(provider.search);

        await jest.advanceTimersByTimeAsync(30_000);
        const response = await pending;
        expect(JSON.parse(response.body).result).toEqual({
          content: [{ type: "text", text: "The web provider request timed out." }],
          isError: true,
        });
        expect(signal?.aborted).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it("aborts a hanging provider call when its session is deleted", async () => {
      const provider = createProvider();
      const deferred = deferredValue<typeof SEARCH_RESULT>();
      let signal: AbortSignal | undefined;
      provider.search.mockImplementation((_query, options) => {
        signal = options?.signal;
        return deferred.promise;
      });
      harness = await createHarness(provider);
      const sessionId = await initializeRaw(harness.bridge);
      const pending = postRpc(
        harness.bridge,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "web_search", arguments: { query: "delete me" } },
        },
        sessionId
      );
      await waitForMockCall(provider.search);

      const deleted = await deleteSession(harness.bridge, sessionId);
      expect(deleted.status).toBe(200);
      expect(signal?.aborted).toBe(true);
      await expect(pending).rejects.toBeDefined();

      deferred.resolve(SEARCH_RESULT);
    });

    it("suppresses a provider result that arrives after disposal", async () => {
      const provider = createProvider();
      const deferred = deferredValue<typeof SEARCH_RESULT>();
      let signal: AbortSignal | undefined;
      provider.search.mockImplementation((_query, options) => {
        signal = options?.signal;
        return deferred.promise;
      });
      harness = await createHarness(provider);
      const sessionId = await initializeRaw(harness.bridge);
      const pending = postRpc(
        harness.bridge,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "web_search", arguments: { query: "dispose me" } },
        },
        sessionId
      );
      await waitForMockCall(provider.search);

      await harness.bridge.dispose();
      expect(signal?.aborted).toBe(true);
      deferred.resolve(SEARCH_RESULT);
      await expect(pending).rejects.toBeDefined();
    });
  });
});

function createProvider(): jest.Mocked<WebProvider> {
  return {
    search: jest.fn().mockResolvedValue(SEARCH_RESULT),
    fetch: jest.fn().mockResolvedValue(FETCH_RESULT),
    testConnection: jest.fn().mockResolvedValue(undefined),
  };
}

function deferredValue<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function waitForMockCall(mock: { mock: { calls: unknown[][] } }): Promise<void> {
  for (let attempt = 0; attempt < 10 && mock.mock.calls.length === 0; attempt += 1) {
    await new Promise<void>((resolve) => scheduleImmediate(resolve));
  }
  expect(mock).toHaveBeenCalled();
}

function readTextOnlyResult(toolResult: {
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
}): unknown {
  const textContent = toolResult.content.find((item) => item.type === "text")?.text;
  expect(typeof textContent).toBe("string");
  return JSON.parse(textContent as string);
}

async function createHarness(provider: WebProvider | undefined): Promise<BridgeHarness> {
  let currentProvider = provider;
  const getProvider = jest.fn(() => currentProvider);
  const bridge = await startAgentWebBridge({ getProvider });
  return {
    bridge,
    getProvider,
    setProvider(nextProvider) {
      currentProvider = nextProvider;
    },
  };
}

function initializeMessage(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "raw-test", version: "1.0.0" },
    },
  };
}

async function initializeRaw(bridge: AgentWebBridge): Promise<string> {
  const response = await requestRaw(bridge.url, {
    method: "POST",
    headers: authenticatedHeaders(bridge, {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    }),
    body: JSON.stringify(initializeMessage()),
  });
  expect(response.status).toBe(200);
  const sessionId = header(response, "mcp-session-id");
  expect(sessionId).toBeTruthy();
  expect(JSON.parse(response.body).result.protocolVersion).toBe("2025-11-25");
  return sessionId!;
}

async function postRpc(
  bridge: AgentWebBridge,
  message: Record<string, unknown>,
  sessionId?: string
): Promise<RawResponse> {
  return requestRaw(bridge.url, {
    method: "POST",
    headers: authenticatedHeaders(bridge, {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    }),
    body: JSON.stringify(message),
  });
}

async function deleteSession(bridge: AgentWebBridge, sessionId: string): Promise<RawResponse> {
  return requestRaw(bridge.url, {
    method: "DELETE",
    headers: authenticatedHeaders(bridge, { "mcp-session-id": sessionId }),
  });
}

function authenticatedHeaders(
  bridge: AgentWebBridge,
  overrides: Record<string, string>
): Record<string, string> {
  return {
    authorization: `Bearer ${bridge.token}`,
    ...overrides,
  };
}

function requestRaw(
  url: string,
  options: { method: string; headers: Record<string, string>; body?: string }
): Promise<RawResponse> {
  const target = new URL(url);
  return new Promise<RawResponse>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: options.method,
        headers: options.headers,
      },
      (response) => collectResponse(response, resolve)
    );
    request.once("error", reject);
    request.setTimeout(2_000, () => request.destroy(new Error("raw request timeout")));
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

function collectResponse(response: IncomingMessage, resolve: (value: RawResponse) => void): void {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk: string) => {
    body += chunk;
  });
  response.once("end", () =>
    resolve({ status: response.statusCode ?? 0, headers: response.headers, body })
  );
}

function openSse(bridge: AgentWebBridge, sessionId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const target = new URL(bridge.url);
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: Number(target.port),
        path: target.pathname,
        method: "GET",
        headers: authenticatedHeaders(bridge, {
          accept: "text/event-stream",
          "mcp-session-id": sessionId,
        }),
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`unexpected SSE status ${response.statusCode ?? 0}`));
          return;
        }
        response.on("data", () => undefined);
        response.once("close", () => resolve());
      }
    );
    request.once("error", reject);
    request.end();
  });
}

class TestFetchResponse {
  readonly ok: boolean;
  readonly statusText: string;
  readonly headers: Headers;
  readonly body = null;

  constructor(
    readonly status: number,
    private readonly responseBody: string,
    responseHeaders: Headers
  ) {
    this.ok = status >= 200 && status < 300;
    this.statusText = String(status);
    this.headers = responseHeaders;
  }

  async text(): Promise<string> {
    return this.responseBody;
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.responseBody);
  }
}

function fetchForMcp(input: string | URL, init?: RequestInit): Promise<Response> {
  const target = new URL(input);
  const headers = new Headers(init?.headers);
  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    requestHeaders[key] = value;
  });

  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: init?.method ?? "GET",
        headers: requestHeaders,
      },
      (response) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined)
            responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        if (init?.method === "GET") {
          response.resume();
          response.destroy();
          resolve(
            new TestFetchResponse(
              response.statusCode ?? 0,
              "",
              responseHeaders
            ) as unknown as Response
          );
          return;
        }

        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.once("end", () => {
          resolve(
            new TestFetchResponse(
              response.statusCode ?? 0,
              body,
              responseHeaders
            ) as unknown as Response
          );
        });
      }
    );
    request.once("error", reject);
    if (typeof init?.body === "string") request.write(init.body);
    request.end();
  });
}

function header(response: RawResponse, name: string): string | undefined {
  const value = response.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
