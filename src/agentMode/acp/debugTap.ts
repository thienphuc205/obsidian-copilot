import { logInfo } from "@/logger";
import { getSettings } from "@/settings/model";
import { formatPayload, frameSink, type FrameRecord } from "@/agentMode/session/debugSink";

interface JsonRpcFrame {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

const REDACTED_VALUE = "<redacted>";
const BEARER_VALUE = /(\bBearer\s+)[^\s"',}]+/gi;
const SECRET_ASSIGNMENT =
  /((?:"?(?:authorization|proxy-authorization|token|api[_-]?key|firecrawl[_-]?(?:api[_-]?)?key|copilot[_-]?web[_-]?bridge[_-]?token|copilot[_-]?plus[_-]?license[_-]?key)"?\s*[:=]\s*["']))[^"']*/gi;
const UNQUOTED_SECRET_ASSIGNMENT =
  /((?:\b(?:authorization|proxy-authorization|token|api[_-]?key|firecrawl[_-]?(?:api[_-]?)?key|copilot[_-]?web[_-]?bridge[_-]?token|copilot[_-]?plus[_-]?license[_-]?key)\b\s*[:=]\s*))[^\s"',}\]]+/gi;
const INLINE_SECRET =
  /((?:COPILOT_WEB_BRIDGE_TOKEN|FIRECRAWL_API_KEY|FIRECRAWL_API_TOKEN)\s*[=:]\s*)[^\s"',}]+/gi;
const TOKEN_ARGUMENT =
  /((?:--(?:token|bridge-token|authorization|api-key)\s*[= ]\s*))([^\s"',}\]]+)/gi;
const TOKEN_FLAG = /^--(?:token|bridge-token|authorization|api-key)$/i;

/**
 * Clone a JSON-RPC payload while replacing credential-shaped values. Logging
 * must never mutate the live request/response object that the ACP SDK uses.
 */
export function redactSensitivePayload(
  value: unknown,
  additionalSecrets: readonly string[] = []
): unknown {
  if (typeof value === "string") return redactSensitiveText(value, additionalSecrets);
  if (Array.isArray(value)) {
    let redactNext = false;
    return value.map((entry) => {
      if (redactNext) {
        redactNext = false;
        return REDACTED_VALUE;
      }
      if (typeof entry === "string" && TOKEN_FLAG.test(entry)) {
        redactNext = true;
        return entry;
      }
      return redactSensitivePayload(entry, additionalSecrets);
    });
  }
  if (value === null || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const siblingName = typeof record.name === "string" ? record.name : "";
  const siblingIsSensitive = isSensitiveName(siblingName);
  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    const valueKey = key === "value" || key === "val";
    if (isSensitiveName(key) || (valueKey && siblingIsSensitive)) {
      redacted[key] = REDACTED_VALUE;
    } else {
      redacted[key] = redactSensitivePayload(nested, additionalSecrets);
    }
  }
  return redacted;
}

function isSensitiveName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[-_]/g, "");
  return (
    normalized === "authorization" ||
    normalized === "proxyauthorization" ||
    normalized === "token" ||
    normalized.endsWith("token") ||
    normalized.includes("apikey") ||
    normalized.includes("bridgetoken") ||
    normalized.includes("firecrawl") ||
    normalized.endsWith("licensekey")
  );
}

export function redactSensitiveText(
  value: string,
  additionalSecrets: readonly string[] = []
): string {
  let redacted = value
    .replace(BEARER_VALUE, "$1" + REDACTED_VALUE)
    .replace(SECRET_ASSIGNMENT, "$1" + REDACTED_VALUE)
    .replace(UNQUOTED_SECRET_ASSIGNMENT, "$1" + REDACTED_VALUE)
    .replace(INLINE_SECRET, "$1" + REDACTED_VALUE)
    .replace(TOKEN_ARGUMENT, "$1" + REDACTED_VALUE);
  // An ACP error can echo a secret in an arbitrary provider message rather than
  // a credential-shaped JSON field. Replace only credentials captured from the
  // active spawn descriptor; never pass a user query or other scalar payload
  // into this list. Longest-first avoids leaving a suffix of an overlapping
  // credential visible.
  const literalSecrets = Array.from(
    new Set(additionalSecrets.filter((secret) => typeof secret === "string" && secret.length > 0))
  ).sort((a, b) => b.length - a.length);
  for (const secret of literalSecrets) redacted = redacted.split(secret).join(REDACTED_VALUE);
  return redacted;
}

/**
 * Make a safe copy of an ACP error for logger/UI consumers. The copy retains
 * the original prototype (including SDK RequestError), numeric code, and
 * structured data shape while sanitizing message/stack and nested values. The
 * live error is deliberately never mutated because the ACP caller may still
 * inspect it after this boundary.
 */
export function redactSensitiveError(
  value: unknown,
  additionalSecrets: readonly string[] = []
): unknown {
  if (!(value instanceof Error)) return redactSensitivePayload(value, additionalSecrets);

  const copy = Object.create(Reflect.getPrototypeOf(value) ?? Error.prototype) as Error;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if (!("value" in descriptor)) {
      Object.defineProperty(copy, key, descriptor);
      continue;
    }
    const propertyName = typeof key === "string" ? key : "";
    const safeValue =
      (propertyName === "message" || propertyName === "stack") &&
      typeof descriptor.value === "string"
        ? redactSensitiveText(descriptor.value, additionalSecrets)
        : redactSensitivePayload(descriptor.value, additionalSecrets);
    Object.defineProperty(copy, key, { ...descriptor, value: safeValue });
  }
  return copy;
}

/**
 * Wrap the subprocess stdin/stdout streams so every NDJSON-framed
 * JSON-RPC message is logged in both directions. Outbound is what
 * `ClientSideConnection` writes to stdin; inbound is what we read from
 * stdout. The taps are passthroughs — bytes flow through unchanged.
 *
 * Method names are remembered per request id so that responses (which
 * carry only id + result/error) can be labeled with the method they
 * answered. `additionalSecrets` is limited to active spawn credentials so
 * arbitrary provider error text is safe without redacting user query text.
 */
export function wrapStreamsForDebug(
  stdin: WritableStream<Uint8Array>,
  stdout: ReadableStream<Uint8Array>,
  tag: string,
  additionalSecrets: readonly string[] = []
): { stdin: WritableStream<Uint8Array>; stdout: ReadableStream<Uint8Array> } {
  const outboundPending = new Map<string, string>();
  const inboundPending = new Map<string, string>();

  return {
    stdin: tapWritable(stdin, (line) =>
      logFrame("→", line, tag, outboundPending, inboundPending, additionalSecrets)
    ),
    stdout: tapReadable(stdout, (line) =>
      logFrame("←", line, tag, inboundPending, outboundPending, additionalSecrets)
    ),
  };
}

function tapWritable(
  inner: WritableStream<Uint8Array>,
  onLine: (line: string) => void
): WritableStream<Uint8Array> {
  // Avoid `TransformStream` / `pipeTo` because the inner stream comes from
  // Node's `Writable.toWeb()` and is branded against `node:internal/
  // webstreams`; mixing it with global-realm streams throws
  // `ERR_INVALID_ARG_TYPE`. A hand-rolled WritableStream that delegates to
  // the inner writer side-steps the realm check entirely.
  const writer = inner.getWriter();
  const splitter = new NdjsonLineSplitter(onLine);
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      splitter.push(chunk);
      await writer.write(chunk);
    },
    async close() {
      splitter.flush();
      await writer.close();
    },
    async abort(reason) {
      splitter.flush();
      await writer.abort(reason);
    },
  });
}

function tapReadable(
  inner: ReadableStream<Uint8Array>,
  onLine: (line: string) => void
): ReadableStream<Uint8Array> {
  // `tee()` is a same-realm method (no class mismatch), so we get two
  // branded-equivalent ReadableStreams: one for the SDK to consume, one we
  // drain ourselves for logging.
  const [forConsumer, forLogging] = inner.tee();
  const splitter = new NdjsonLineSplitter(onLine);
  void (async () => {
    const reader = forLogging.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) splitter.push(value);
      }
      splitter.flush();
    } catch {
      // Stream closed/aborted; nothing for the tap to do.
    }
  })();
  return forConsumer;
}

/**
 * Accumulates stream bytes and hands out one complete NDJSON line at a time,
 * so callers never see a frame that a chunk boundary cut in half.
 */
export class NdjsonLineSplitter {
  private buffer = "";
  private decoder = new TextDecoder();

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.emit(line);
    }
  }

  flush(): void {
    const tail = this.buffer.trim();
    this.buffer = "";
    if (tail) this.emit(tail);
  }

  private emit(line: string): void {
    try {
      this.onLine(line);
    } catch {
      // Logging must never break the protocol stream.
    }
  }
}

function logFrame(
  arrow: "→" | "←",
  line: string,
  tag: string,
  /** Pending requests originated by *our* side of this stream. */
  ownPending: Map<string, string>,
  /** Pending requests originated by the *other* side of this stream. */
  peerPending: Map<string, string>,
  additionalSecrets: readonly string[]
): void {
  // Read once per frame so the hot path doesn't allocate a record + timestamp
  // when the toggle is off.
  const fullFramesOn = !!getSettings().agentMode?.debugFullFrames;
  const emit = fullFramesOn
    ? (kind: FrameRecord["kind"], method: string, id: string | null, payload: unknown) =>
        frameSink.append({
          ts: new Date().toISOString(),
          dir: arrow,
          tag,
          kind,
          method,
          id,
          payload,
        })
    : null;

  let frame: JsonRpcFrame;
  try {
    frame = JSON.parse(line);
  } catch {
    const safeLine = redactSensitiveText(line, additionalSecrets);
    logInfo(`[ACP ${arrow}][${tag}] (unparsed) ${formatPayload(safeLine)}`);
    emit?.("raw", "(unparsed)", null, { raw: safeLine });
    return;
  }

  const idStr = frame.id !== undefined ? String(frame.id) : null;

  if (frame.method) {
    // Request or notification.
    const method = frame.method;
    const idLabel = idStr !== null ? `#${idStr}` : "(notif)";
    if (idStr !== null) ownPending.set(idStr, method);
    const safeParams = redactSensitivePayload(frame.params, additionalSecrets);
    logInfo(`[ACP ${arrow}][${tag}] ${method}  ${idLabel}  ${formatPayload(safeParams)}`);
    emit?.(idStr !== null ? "request" : "notif", method, idStr, safeParams);
    return;
  }

  // Response (result or error). Method name comes from the side that
  // originated the request — that's `peerPending` from this stream's
  // perspective.
  const method = idStr !== null ? (peerPending.get(idStr) ?? "(unknown)") : "(unknown)";
  if (idStr !== null) peerPending.delete(idStr);
  const idLabel = idStr !== null ? `#${idStr}` : "(no-id)";
  if (frame.error) {
    const safeError = redactSensitivePayload(frame.error, additionalSecrets);
    logInfo(`[ACP ${arrow}][${tag}] (error) ${method}  ${idLabel}  ${formatPayload(safeError)}`);
    emit?.("error", method, idStr, safeError);
  } else {
    const safeResult = redactSensitivePayload(frame.result, additionalSecrets);
    logInfo(`[ACP ${arrow}][${tag}] ${method}  ${idLabel}  ${formatPayload(safeResult)}`);
    emit?.("result", method, idStr, safeResult);
  }
}
