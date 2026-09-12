import { requireNodeModule } from "@/utils/desktopRuntime";
import {
  WebProviderError,
  type WebFetchResult,
  type WebProvider,
  type WebSearchResult,
  type WebSource,
} from "@/web/types";

type IncomingMessage = import("node:http").IncomingMessage;
type Server = import("node:http").Server;
type ServerResponse = import("node:http").ServerResponse;
type Socket = import("node:net").Socket;
type NodeHttpModule = typeof import("node:http");
type NodeCryptoModule = typeof import("node:crypto");

const MCP_PATH = "/mcp";
const LOOPBACK_HOST = "127.0.0.1";
const MCP_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;
const DEFAULT_MCP_PROTOCOL_VERSION = MCP_PROTOCOL_VERSIONS[0];
const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_CONCURRENT_REQUESTS = 8;
const MAX_CONCURRENT_TOOL_CALLS = 4;
const MAX_SESSIONS = 8;
const MAX_QUERY_LENGTH = 512;
const MAX_URL_LENGTH = 2048;
const MAX_OUTPUT_LENGTH = 100_000;
const MAX_TITLE_LENGTH = 300;
const MAX_SNIPPET_LENGTH = 2_000;
const MAX_PUBLISHED_AT_LENGTH = 128;
const MAX_SOURCES = 10;
const MAX_CITATIONS = 50;
const REQUEST_BODY_IDLE_TIMEOUT_MS = 10_000;
const PROVIDER_OPERATION_DEADLINE_MS = 30_000;
const DISPOSE_CLOSE_DEADLINE_MS = 250;

const TOOL_NAMES = ["web_search", "web_fetch"] as const;
type ToolName = (typeof TOOL_NAMES)[number];
type JsonRpcId = string | number | null;

const WEB_TOOLS = [
  {
    name: "web_search",
    description: "Search the public web through the configured web provider.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: MAX_QUERY_LENGTH },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "web_fetch",
    description: "Fetch one public web page through the configured web provider.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", minLength: 1, maxLength: MAX_URL_LENGTH, format: "uri" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
] as const;

const SAFE_ERROR_MESSAGES = {
  disabled: "Web tools are disabled.",
  unavailable: "Web tools are unavailable.",
  invalidResult: "The web provider returned invalid data.",
  responseLimit: "The web provider response exceeded the bridge limit.",
  tooManyCalls: "Too many concurrent web tool calls.",
  provider: "The web provider request failed.",
  invalidCredentials: "Web provider credentials are invalid.",
  invalidQuery: "The web search query is invalid.",
  invalidUrl: "The web URL is invalid or not public.",
  invalidConfiguration: "The web provider is not configured.",
  unauthorized: "The web provider rejected the request.",
  rateLimited: "The web provider rate limit was reached.",
  quotaExceeded: "The web provider quota was exhausted.",
  badRequest: "The web provider rejected the request.",
  timeout: "The web provider request timed out.",
  server: "The web provider is temporarily unavailable.",
  network: "The web provider could not be reached.",
  malformedResponse: "The web provider returned an invalid response.",
} as const;

/** The provider-credential-free capability handed to the ACP lifecycle. */
export interface AgentWebBridge {
  readonly url: string;
  readonly token: string;
  dispose(): Promise<void>;
}

/** Dependency seam used by the bridge so settings and entitlement state stay outside it. */
export interface StartAgentWebBridgeOptions {
  getProvider: () => WebProvider | undefined;
}

/** Sanitized startup/lifecycle failure for the local bridge. */
export class AgentWebBridgeError extends Error {
  constructor(
    public readonly code: "invalid_configuration" | "startup" | "closed",
    message: string
  ) {
    super(message);
    this.name = "AgentWebBridgeError";
    Object.setPrototypeOf(this, AgentWebBridgeError.prototype);
  }
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcError {
  code: number;
  message: string;
}

interface JsonRpcReply {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: Record<string, unknown>;
  error?: JsonRpcError;
}

interface BridgeSession {
  id: string;
  initialized: boolean;
  closed: boolean;
  sseResponses: Set<ServerResponse>;
}

interface RpcDispatchResult {
  reply: JsonRpcReply | null;
  sessionId?: string;
  dropResponse?: boolean;
}

interface PendingToolCall {
  session: BridgeSession;
  controller: AbortController;
}

class BodyLimitError extends Error {}

class BodyReadError extends Error {}

class ProviderResultError extends Error {}

class ProviderOperationAbortedError extends Error {}

class ProviderOperationDeadlineError extends Error {}

/**
 * Start the authenticated MCP Streamable HTTP bridge used by the ACP boundary.
 *
 * Node modules are loaded only after this desktop-only capability is requested;
 * importing this module therefore remains safe on mobile and in the regular
 * plugin web bundle. The bridge never owns provider settings or credentials.
 */
export async function startAgentWebBridge(
  options: StartAgentWebBridgeOptions
): Promise<AgentWebBridge> {
  if (!isRecord(options) || typeof options.getProvider !== "function") {
    throw new AgentWebBridgeError(
      "invalid_configuration",
      "The web bridge configuration is invalid."
    );
  }

  let http: NodeHttpModule;
  let crypto: NodeCryptoModule;
  try {
    http = requireNodeModule<NodeHttpModule>("http");
    crypto = requireNodeModule<NodeCryptoModule>("crypto");
  } catch {
    throw new AgentWebBridgeError(
      "startup",
      "The web bridge is available only in the desktop runtime."
    );
  }

  let token: string;
  try {
    token = crypto.randomBytes(32).toString("hex");
  } catch {
    throw new AgentWebBridgeError("startup", "The web bridge could not start.");
  }

  let server: Server;
  let disposed = false;
  let activeRequests = 0;
  let disposePromise: Promise<void> | null = null;
  let expectedHost = "";
  const sockets = new Set<Socket>();
  const sessions = new Map<string, BridgeSession>();
  const pendingToolCalls = new Set<PendingToolCall>();

  const closeSession = (session: BridgeSession): void => {
    session.closed = true;
    for (const response of session.sseResponses) {
      response.destroy();
    }
    session.sseResponses.clear();
  };

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;

    disposed = true;
    abortPendingToolCalls(pendingToolCalls);
    for (const session of sessions.values()) {
      closeSession(session);
    }
    sessions.clear();

    disposePromise = new Promise<void>((resolve) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        window.clearTimeout(deadline);
        resolve();
      };
      const deadline = window.setTimeout(finish, DISPOSE_CLOSE_DEADLINE_MS);

      for (const socket of sockets) {
        socket.destroy();
      }

      try {
        const closeIdleConnections = (server as Server & { closeIdleConnections?: () => void })
          .closeIdleConnections;
        closeIdleConnections?.call(server);
        server.close(() => finish());
      } catch {
        finish();
      }
    });

    return disposePromise;
  };

  const isAuthorized = (request: IncomingMessage): boolean => {
    const authorization = getHeader(request, "authorization");
    const expected = `Bearer ${token}`;
    const actual = authorization ?? "";
    let difference = actual.length ^ expected.length;
    const length = Math.max(actual.length, expected.length);
    for (let index = 0; index < length; index += 1) {
      difference |= (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
    }
    return difference === 0;
  };

  const isValidOrigin = (request: IncomingMessage): boolean => {
    const origin = getHeader(request, "origin");
    return origin === undefined || origin === `http://${expectedHost}`;
  };

  const sendHttpError = (response: ServerResponse, status: number, message: string): void => {
    sendJson(
      response,
      status,
      { error: message },
      {
        Connection: "close",
        ...(status === 405 ? { Allow: "GET, POST, DELETE, OPTIONS" } : {}),
        ...(status === 401 ? { "WWW-Authenticate": "Bearer" } : {}),
      }
    );
  };

  const sendRpcReply = (
    response: ServerResponse,
    reply: JsonRpcReply,
    sessionId?: string
  ): void => {
    if (sessionId) response.setHeader("Mcp-Session-Id", sessionId);
    const body = JSON.stringify(reply);
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
      sendJsonRpcError(response, reply.id, -32603, SAFE_ERROR_MESSAGES.responseLimit);
      return;
    }

    sendJson(response, 200, reply, sessionId ? { "Mcp-Session-Id": sessionId } : undefined);
  };

  const sendNotificationAccepted = (response: ServerResponse): void => {
    response.writeHead(202, {
      "Cache-Control": "no-store",
      "Content-Length": "0",
      "X-Content-Type-Options": "nosniff",
    });
    response.end();
  };

  const handlePost = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
      request.resume();
      sendHttpError(response, 429, "Too many concurrent requests.");
      return;
    }

    activeRequests += 1;
    let message: JsonRpcRequest | null = null;
    try {
      if (!hasMediaType(getHeader(request, "content-type"), "application/json")) {
        request.resume();
        sendHttpError(response, 415, "JSON requests are required.");
        return;
      }
      const accept = getHeader(request, "accept");
      if (!hasMediaType(accept, "application/json") || !hasMediaType(accept, "text/event-stream")) {
        request.resume();
        sendHttpError(response, 406, "Both JSON and event-stream responses are required.");
        return;
      }

      let body: string;
      try {
        body = await readBody(request);
      } catch (error) {
        if (error instanceof BodyLimitError) {
          sendHttpError(response, 413, "The request body is too large.");
        } else {
          sendHttpError(response, 408, "The request body could not be read.");
        }
        return;
      }

      try {
        message = parseJsonRpcRequest(JSON.parse(body));
      } catch {
        sendJsonRpcError(response, null, -32600, "Invalid request.", 400);
        return;
      }

      const sessionId = getHeader(request, "mcp-session-id");
      if (message.method === "initialize" && sessionId) {
        sendJsonRpcError(response, null, -32600, "Invalid request.", 400);
        return;
      }
      if (message.method !== "initialize") {
        if (!sessionId) {
          sendJsonRpcError(response, null, -32000, "The MCP session is required.", 400);
          return;
        }
        if (!sessions.has(sessionId)) {
          sendJsonRpcError(response, null, -32001, "The MCP session was not found.", 404);
          return;
        }
      }

      const dispatch = await dispatchRpcMessage(
        message,
        sessionId,
        options.getProvider,
        crypto,
        sessions,
        pendingToolCalls,
        (id) => !disposed && isLiveSession(sessions, id)
      );

      if (dispatch.dropResponse) {
        response.destroy();
        return;
      }
      if (disposed || response.destroyed) return;
      if (dispatch.reply === null) {
        sendNotificationAccepted(response);
      } else {
        sendRpcReply(response, dispatch.reply, dispatch.sessionId);
      }
    } catch {
      if (disposed || response.destroyed) return;
      if (message && hasRpcId(message)) {
        sendJsonRpcError(response, message.id ?? null, -32603, "The web bridge request failed.");
      } else {
        sendHttpError(response, 500, "The web bridge request failed.");
      }
    } finally {
      activeRequests -= 1;
    }
  };

  const handleGet = (request: IncomingMessage, response: ServerResponse): void => {
    const accept = getHeader(request, "accept");
    if (!hasMediaType(accept, "text/event-stream")) {
      sendHttpError(response, 406, "An event-stream response is required.");
      return;
    }

    const sessionId = getHeader(request, "mcp-session-id");
    if (!sessionId) {
      // The installed StreamableHTTP client uses 405 as the optional-SSE probe
      // before it has a session; authenticated session GETs below are real SSE.
      sendHttpError(response, 405, "The event stream requires an MCP session.");
      return;
    }

    const session = sessions.get(sessionId);
    if (!session || !session.initialized) {
      sendHttpError(response, 404, "The MCP session was not found.");
      return;
    }
    if (session.sseResponses.size > 0) {
      sendHttpError(response, 409, "Only one MCP event stream is allowed per session.");
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "Mcp-Session-Id": session.id,
      "X-Content-Type-Options": "nosniff",
    });
    response.write(": connected\n\n");
    session.sseResponses.add(response);
    response.on("close", () => session.sseResponses.delete(response));
  };

  const handleDelete = (request: IncomingMessage, response: ServerResponse): void => {
    const sessionId = getHeader(request, "mcp-session-id");
    if (!sessionId || !sessions.has(sessionId)) {
      sendHttpError(response, 404, "The MCP session was not found.");
      return;
    }
    const session = sessions.get(sessionId);
    if (session) {
      abortPendingToolCalls(pendingToolCalls, session);
      closeSession(session);
    }
    sessions.delete(sessionId);
    sendJson(response, 200, { ok: true });
  };

  const handleRequest = (request: IncomingMessage, response: ServerResponse): void => {
    if (!isAuthorized(request)) {
      sendHttpError(response, 401, "Unauthorized.");
      return;
    }
    if (getHeader(request, "host") !== expectedHost) {
      sendHttpError(response, 421, "The request host is not allowed.");
      return;
    }
    if (!isValidOrigin(request)) {
      sendHttpError(response, 403, "The request origin is not allowed.");
      return;
    }
    const requestedProtocolVersion = getHeader(request, "mcp-protocol-version");
    if (
      requestedProtocolVersion !== undefined &&
      !isSupportedProtocolVersion(requestedProtocolVersion)
    ) {
      sendHttpError(response, 400, "The MCP protocol version is not supported.");
      return;
    }

    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", `http://${expectedHost}`).pathname;
    } catch {
      sendHttpError(response, 400, "The request URL is invalid.");
      return;
    }
    if (disposed) {
      sendHttpError(response, 410, "The web bridge is closed.");
      return;
    }
    if (pathname !== MCP_PATH) {
      sendHttpError(response, 404, "The requested route was not found.");
      return;
    }

    request.setTimeout(REQUEST_BODY_IDLE_TIMEOUT_MS, () => request.destroy());
    switch (request.method) {
      case "POST":
        void handlePost(request, response);
        return;
      case "GET":
        request.setTimeout(0);
        handleGet(request, response);
        return;
      case "DELETE":
        request.setTimeout(0);
        handleDelete(request, response);
        return;
      case "OPTIONS":
        request.setTimeout(0);
        response.writeHead(204, {
          Allow: "GET, POST, DELETE, OPTIONS",
          "Content-Length": "0",
          "X-Content-Type-Options": "nosniff",
        });
        response.end();
        return;
      default:
        request.resume();
        sendHttpError(response, 405, "The HTTP method is not allowed.");
    }
  };

  server = http.createServer(handleRequest);
  server.maxConnections = MAX_SESSIONS + MAX_CONCURRENT_REQUESTS;
  server.keepAliveTimeout = REQUEST_BODY_IDLE_TIMEOUT_MS;
  server.headersTimeout = REQUEST_BODY_IDLE_TIMEOUT_MS + 1_000;
  server.on("error", () => {
    if (!disposed) void dispose();
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  try {
    const port = await listenOnLoopback(server);
    expectedHost = `${LOOPBACK_HOST}:${port}`;
    server.unref();
  } catch {
    try {
      server.close();
    } catch {
      // The startup error is intentionally sanitized for the caller.
    }
    throw new AgentWebBridgeError("startup", "The web bridge could not start.");
  }

  return Object.freeze({
    url: `http://${expectedHost}${MCP_PATH}`,
    token,
    dispose,
  });
}

async function listenOnLoopback(server: Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const onError = (): void => reject(new Error("listen failed"));
    server.once("error", onError);
    server.listen(0, LOOPBACK_HOST, () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("listen returned no TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

function isLiveSession(sessions: Map<string, BridgeSession>, sessionId: string): boolean {
  const session = sessions.get(sessionId);
  return session !== undefined && session.initialized && !session.closed;
}

function abortPendingToolCalls(
  pendingToolCalls: Set<PendingToolCall>,
  session?: BridgeSession
): void {
  for (const pendingToolCall of pendingToolCalls) {
    if (session === undefined || pendingToolCall.session === session) {
      pendingToolCall.controller.abort();
    }
  }
}

async function withProviderDeadline<T>(
  pendingToolCall: PendingToolCall,
  operation: () => Promise<T>
): Promise<T> {
  const { controller } = pendingToolCall;
  let deadlineId: number | undefined;
  let abortListener: (() => void) | undefined;
  const operationPromise = controller.signal.aborted
    ? Promise.reject<T>(new ProviderOperationAbortedError())
    : Promise.resolve().then(operation);
  const deadlinePromise = new Promise<never>((_, reject) => {
    deadlineId = window.setTimeout(() => {
      reject(new ProviderOperationDeadlineError());
      controller.abort();
    }, PROVIDER_OPERATION_DEADLINE_MS);
  });
  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = (): void => reject(new ProviderOperationAbortedError());
    if (controller.signal.aborted) {
      abortListener();
      return;
    }
    controller.signal.addEventListener("abort", abortListener, { once: true });
  });

  try {
    return await Promise.race([operationPromise, deadlinePromise, abortPromise]);
  } finally {
    if (deadlineId !== undefined) window.clearTimeout(deadlineId);
    if (abortListener !== undefined) {
      controller.signal.removeEventListener("abort", abortListener);
    }
  }
}

async function dispatchRpcMessage(
  message: JsonRpcRequest,
  sessionId: string | undefined,
  getProvider: () => WebProvider | undefined,
  crypto: NodeCryptoModule,
  sessions: Map<string, BridgeSession>,
  pendingToolCalls: Set<PendingToolCall>,
  isBridgeSessionLive: (sessionId: string) => boolean
): Promise<RpcDispatchResult> {
  const isNotification = !hasRpcId(message);

  if (message.method === "initialize") {
    if (sessionId) return { reply: rpcError(message.id ?? null, -32600, "Invalid request.") };
    if (isNotification) return { reply: null };
    if (!isValidInitializeParams(message.params)) {
      return { reply: rpcError(message.id ?? null, -32602, "Invalid initialize parameters.") };
    }
    if (sessions.size >= MAX_SESSIONS) {
      return { reply: rpcError(message.id ?? null, -32000, "Too many MCP sessions.") };
    }

    let newSessionId: string;
    try {
      newSessionId = crypto.randomBytes(16).toString("hex");
    } catch {
      return { reply: rpcError(message.id ?? null, -32603, "The web bridge request failed.") };
    }
    sessions.set(newSessionId, {
      id: newSessionId,
      initialized: true,
      closed: false,
      sseResponses: new Set(),
    });
    const requestedVersion = (message.params as Record<string, unknown>).protocolVersion;
    const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(
      requestedVersion as (typeof MCP_PROTOCOL_VERSIONS)[number]
    )
      ? requestedVersion
      : DEFAULT_MCP_PROTOCOL_VERSION;
    return {
      sessionId: newSessionId,
      reply: {
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "obsidian-copilot-web", version: "1.0.0" },
        },
      },
    };
  }

  if (
    message.method === "notifications/initialized" ||
    message.method === "notifications/cancelled"
  ) {
    return { reply: null };
  }

  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session || !session.initialized) {
    if (isNotification) return { reply: null };
    return { reply: rpcError(message.id ?? null, -32001, "The MCP session was not found.") };
  }

  if (message.method === "ping") {
    if (!isEmptyParams(message.params)) {
      return { reply: rpcError(message.id ?? null, -32602, "Invalid ping parameters.") };
    }
    return { reply: isNotification ? null : rpcResult(message.id ?? null, {}) };
  }

  if (message.method === "tools/list") {
    let provider: WebProvider | undefined;
    try {
      provider = getProvider();
    } catch {
      provider = undefined;
    }
    return {
      reply: isNotification
        ? null
        : rpcResult(message.id ?? null, { tools: provider ? WEB_TOOLS : [] }),
    };
  }

  if (message.method === "tools/call") {
    let provider: WebProvider | undefined;
    try {
      provider = getProvider();
    } catch {
      provider = undefined;
    }
    if (isNotification) return { reply: null };
    if (!provider) {
      return {
        reply: rpcResult(message.id ?? null, {
          content: [{ type: "text", text: SAFE_ERROR_MESSAGES.disabled }],
          isError: true,
        }),
      };
    }

    const call = parseToolCall(message.params);
    if (!call) return { reply: rpcError(message.id ?? null, -32602, "Invalid tool parameters.") };
    if (!hasCallableProviderMethod(provider, call.name)) {
      return {
        reply: rpcResult(message.id ?? null, {
          content: [{ type: "text", text: SAFE_ERROR_MESSAGES.unavailable }],
          isError: true,
        }),
      };
    }
    if (pendingToolCalls.size >= MAX_CONCURRENT_TOOL_CALLS) {
      return {
        reply: rpcResult(message.id ?? null, {
          content: [{ type: "text", text: SAFE_ERROR_MESSAGES.tooManyCalls }],
          isError: true,
        }),
      };
    }

    const pendingToolCall: PendingToolCall = {
      session,
      controller: new AbortController(),
    };
    pendingToolCalls.add(pendingToolCall);
    try {
      const toolResult =
        call.name === "web_search"
          ? await withProviderDeadline(pendingToolCall, () =>
              provider.search(call.arguments.query, {
                ...(call.arguments.limit === undefined ? {} : { limit: call.arguments.limit }),
                signal: pendingToolCall.controller.signal,
              })
            )
          : await withProviderDeadline(pendingToolCall, () =>
              provider.fetch(call.arguments.url, { signal: pendingToolCall.controller.signal })
            );
      if (!isBridgeSessionLive(session.id)) {
        return { reply: null, dropResponse: true };
      }
      const normalized = normalizeProviderResult(call.name, toolResult);
      const reply = rpcResult(message.id ?? null, {
        content: [{ type: "text", text: JSON.stringify(normalized) }],
        structuredContent: normalized,
      });
      if (serializedByteLength(reply) > MAX_RESPONSE_BYTES) {
        return {
          reply: rpcResult(message.id ?? null, {
            content: [{ type: "text", text: SAFE_ERROR_MESSAGES.responseLimit }],
            isError: true,
          }),
        };
      }
      return { reply };
    } catch (error) {
      if (!isBridgeSessionLive(session.id)) {
        return { reply: null, dropResponse: true };
      }
      const messageText =
        error instanceof ProviderResultError
          ? SAFE_ERROR_MESSAGES.invalidResult
          : error instanceof ProviderOperationDeadlineError
            ? SAFE_ERROR_MESSAGES.timeout
            : error instanceof ProviderOperationAbortedError
              ? SAFE_ERROR_MESSAGES.provider
              : error instanceof WebProviderError
                ? providerErrorMessage(error)
                : SAFE_ERROR_MESSAGES.provider;
      return {
        reply: rpcResult(message.id ?? null, {
          content: [{ type: "text", text: messageText }],
          isError: true,
        }),
      };
    } finally {
      pendingToolCalls.delete(pendingToolCall);
    }
  }

  return isNotification
    ? { reply: null }
    : { reply: rpcError(message.id ?? null, -32601, "Method not found.") };
}

function parseJsonRpcRequest(value: unknown): JsonRpcRequest {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
    throw new Error("invalid request");
  }
  if (value.method.length === 0 || value.method.length > 128) throw new Error("invalid request");
  if (Object.prototype.hasOwnProperty.call(value, "id") && !isJsonRpcId(value.id)) {
    throw new Error("invalid request");
  }
  return value as unknown as JsonRpcRequest;
}

function isValidInitializeParams(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isBoundedString(value.protocolVersion, 64)) return false;
  if (!isRecord(value.capabilities) || !isRecord(value.clientInfo)) return false;
  return (
    isBoundedString(value.clientInfo.name, 128) && isBoundedString(value.clientInfo.version, 128)
  );
}

function isEmptyParams(value: unknown): boolean {
  return value === undefined || (isRecord(value) && Object.keys(value).length === 0);
}

type ParsedToolCall =
  | { name: "web_search"; arguments: { query: string; limit?: number } }
  | { name: "web_fetch"; arguments: { url: string } };

function parseToolCall(value: unknown): ParsedToolCall | null {
  if (!isRecord(value) || typeof value.name !== "string" || !isToolName(value.name)) return null;
  if (Object.keys(value).some((key) => key !== "name" && key !== "arguments" && key !== "_meta")) {
    return null;
  }
  if (value._meta !== undefined && !isRecord(value._meta)) return null;

  const args = value.arguments === undefined ? {} : value.arguments;
  if (!isRecord(args)) return null;
  if (value.name === "web_search") {
    const query = args.query;
    const limit = args.limit;
    if (
      Object.keys(args).some((key) => key !== "query" && key !== "limit") ||
      !isBoundedString(query, MAX_QUERY_LENGTH) ||
      query.trim().length === 0 ||
      (limit !== undefined &&
        (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 10))
    ) {
      return null;
    }
    return {
      name: "web_search",
      arguments: {
        query,
        ...(typeof limit === "number" ? { limit } : {}),
      },
    };
  }

  const url = args.url;
  if (
    Object.keys(args).some((key) => key !== "url") ||
    !isBoundedString(url, MAX_URL_LENGTH) ||
    !isSafePublicUrl(url)
  ) {
    return null;
  }
  return { name: "web_fetch", arguments: { url } };
}

function hasCallableProviderMethod(provider: WebProvider, name: ToolName): boolean {
  return name === "web_search"
    ? typeof provider.search === "function"
    : typeof provider.fetch === "function";
}

function normalizeProviderResult(name: ToolName, value: unknown): WebSearchResult | WebFetchResult {
  if (!isRecord(value)) throw new ProviderResultError();
  const content = getBoundedString(value.content, MAX_OUTPUT_LENGTH);
  const sources = normalizeSources(value.sources);
  const citations = normalizeCitations(value.citations);
  if (content === undefined || sources === undefined || citations === undefined) {
    throw new ProviderResultError();
  }

  if (name === "web_search") {
    if (value.kind !== "web_search") throw new ProviderResultError();
    return { kind: "web_search", content, sources, citations };
  }

  const url = getBoundedString(value.url, MAX_URL_LENGTH);
  if (
    value.kind !== "web_fetch" ||
    url === undefined ||
    !isSafePublicUrl(url) ||
    typeof value.truncated !== "boolean"
  ) {
    throw new ProviderResultError();
  }
  const title =
    value.title === undefined ? undefined : getBoundedString(value.title, MAX_TITLE_LENGTH);
  if (value.title !== undefined && title === undefined) throw new ProviderResultError();
  return {
    kind: "web_fetch",
    url,
    ...(title === undefined ? {} : { title }),
    content,
    sources,
    citations,
    truncated: value.truncated,
  };
}

function normalizeSources(value: unknown): WebSource[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_SOURCES) return undefined;
  const sources: WebSource[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const title = getBoundedString(item.title, MAX_TITLE_LENGTH);
    const url = getBoundedString(item.url, MAX_URL_LENGTH);
    const snippet =
      item.snippet === undefined ? undefined : getBoundedString(item.snippet, MAX_SNIPPET_LENGTH);
    const publishedAt =
      item.publishedAt === undefined
        ? undefined
        : getBoundedString(item.publishedAt, MAX_PUBLISHED_AT_LENGTH);
    if (title === undefined || url === undefined || !isSafePublicUrl(url)) return undefined;
    if (item.snippet !== undefined && snippet === undefined) return undefined;
    if (item.publishedAt !== undefined && publishedAt === undefined) return undefined;
    sources.push({
      title,
      url,
      ...(snippet === undefined ? {} : { snippet }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    });
  }
  return sources;
}

function normalizeCitations(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CITATIONS) return undefined;
  const citations: string[] = [];
  for (const citation of value) {
    if (!isBoundedString(citation, MAX_URL_LENGTH) || !isSafePublicUrl(citation)) return undefined;
    citations.push(citation);
  }
  return citations;
}

function providerErrorMessage(error: WebProviderError): string {
  switch (error.code) {
    case "invalid_credentials":
      return SAFE_ERROR_MESSAGES.invalidCredentials;
    case "invalid_query":
      return SAFE_ERROR_MESSAGES.invalidQuery;
    case "invalid_url":
      return SAFE_ERROR_MESSAGES.invalidUrl;
    case "invalid_configuration":
      return SAFE_ERROR_MESSAGES.invalidConfiguration;
    case "unauthorized":
      return SAFE_ERROR_MESSAGES.unauthorized;
    case "rate_limited":
      return SAFE_ERROR_MESSAGES.rateLimited;
    case "quota_exceeded":
      return SAFE_ERROR_MESSAGES.quotaExceeded;
    case "bad_request":
      return SAFE_ERROR_MESSAGES.badRequest;
    case "timeout":
      return SAFE_ERROR_MESSAGES.timeout;
    case "server":
      return SAFE_ERROR_MESSAGES.server;
    case "network":
      return SAFE_ERROR_MESSAGES.network;
    case "malformed_response":
      return SAFE_ERROR_MESSAGES.malformedResponse;
    default:
      return SAFE_ERROR_MESSAGES.provider;
  }
}

function rpcResult(id: JsonRpcId, result: Record<string, unknown>): JsonRpcReply {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcReply {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function sendJsonRpcError(
  response: ServerResponse,
  id: JsonRpcId,
  code: number,
  message: string,
  status = 200
): void {
  sendJson(response, status, rpcError(id, code, message));
}

function serializedByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders?: Record<string, string>
): void {
  if (response.destroyed || response.writableEnded) return;
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    body = JSON.stringify({ error: "The web bridge response could not be encoded." });
    status = 500;
  }
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": String(Buffer.byteLength(body, "utf8")),
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}

function readBody(request: IncomingMessage): Promise<string> {
  const contentLength = getHeader(request, "content-length");
  if (
    contentLength !== undefined &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)
  ) {
    request.resume();
    return Promise.reject(new BodyLimitError());
  }

  return new Promise<string>((resolve, reject) => {
    let size = 0;
    const chunks: string[] = [];
    let settled = false;
    const cleanup = (): void => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
      request.setTimeout(0);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: string): void => {
      size += Buffer.byteLength(chunk, "utf8");
      if (size > MAX_BODY_BYTES) {
        request.resume();
        fail(new BodyLimitError());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(chunks.join(""));
    };
    const onError = (): void => fail(new BodyReadError());
    const onAborted = (): void => fail(new BodyReadError());

    request.setEncoding("utf8");
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}

function getHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function hasMediaType(value: string | undefined, mediaType: string): boolean {
  if (!value) return false;
  return value.split(",").some((part) => part.trim().split(";", 1)[0]?.toLowerCase() === mediaType);
}

function hasRpcId(message: JsonRpcRequest): boolean {
  return Boolean(Object.prototype.hasOwnProperty.call(message, "id"));
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

function isSupportedProtocolVersion(value: string): boolean {
  return (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(value);
}

function getBoundedString(value: unknown, maxLength: number): string | undefined {
  return isBoundedString(value, maxLength) ? value : undefined;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isSafePublicUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  return !isPrivateHostLiteral(parsed.hostname);
}

function isPrivateHostLiteral(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    normalized === "localhost" ||
    normalized === "local" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }

  const ipv4 = parseIpv4Literal(normalized);
  if (ipv4) return isPrivateIpv4(ipv4);
  return isMappedPrivateIpv4(normalized);
}

function parseIpv4Literal(hostname: string): [number, number, number, number] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return undefined;
  return octets as [number, number, number, number];
}

function isPrivateIpv4([first, second]: [number, number, number, number]): boolean {
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isMappedPrivateIpv4(hostname: string): boolean {
  if (!hostname.startsWith("::ffff:")) return false;
  const hexParts = hostname.slice("::ffff:".length).split(":");
  if (hexParts.length !== 2 || hexParts.some((part) => !/^[\da-f]{1,4}$/.test(part))) {
    return false;
  }
  const first = Number.parseInt(hexParts[0].slice(0, 2), 16);
  const second = Number.parseInt(hexParts[0].slice(2), 16);
  const third = Number.parseInt(hexParts[1].slice(0, 2), 16);
  const fourth = Number.parseInt(hexParts[1].slice(2), 16);
  return isPrivateIpv4([first, second, third, fourth]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
