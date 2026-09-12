import { toWebSourceReference, type SourceReference } from "@/context/sourceReferences";
import { normalizePublicUrl } from "@/web/publicUrl";

/** Version of the optional Agent Mode source-reference envelope. */
export const CHAT_SOURCE_REF_SCHEMA_VERSION = 1 as const;

/** Maximum number of unique web sources retained on one persisted message. */
export const MAX_CHAT_SOURCE_REFS = 10;

/**
 * Maximum UTF-8 size of the serialized source metadata array, excluding its
 * marker. Four KiB leaves room for ten concise citations without allowing a
 * chat transcript to become an uncontrolled metadata store.
 */
export const MAX_CHAT_SOURCE_REFS_SERIALIZED_BYTES = 4096;

/** The metadata-only source shape allowed in a saved Agent Mode chat. */
export interface ChatSourceRef {
  readonly title: string;
  readonly url: string;
  readonly snippet?: string;
  readonly publishedAt?: string;
}

const MAX_SOURCE_TITLE_LENGTH = 300;
const MAX_SOURCE_SNIPPET_LENGTH = 2_000;
const MAX_SOURCE_PUBLISHED_AT_LENGTH = 128;
const SOURCE_MARKER_PREFIX = `<!-- copilot-agent-source-refs:v${CHAT_SOURCE_REF_SCHEMA_VERSION};metadata `;
const SOURCE_LITERAL_PREFIX = `<!-- copilot-agent-source-refs:v${CHAT_SOURCE_REF_SCHEMA_VERSION};literal `;
const SOURCE_MARKER_SUFFIX = " -->";
const MAX_SOURCE_MARKER_BYTES =
  MAX_CHAT_SOURCE_REFS_SERIALIZED_BYTES + SOURCE_MARKER_PREFIX.length + SOURCE_MARKER_SUFFIX.length;
const MAX_SOURCE_LITERAL_BYTES = MAX_SOURCE_MARKER_BYTES * 2;

const EMPTY_CHAT_SOURCE_REFS: readonly ChatSourceRef[] = Object.freeze([]);

/**
 * Normalize Agent tool citations to the small, safe metadata contract used by
 * persistence. SourceReference fields used for local inspection or ranking
 * are intentionally projected away before serialization.
 */
export function normalizeChatSourceRefs(value: unknown): readonly ChatSourceRef[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHAT_SOURCE_REFS) {
    return EMPTY_CHAT_SOURCE_REFS;
  }

  const seenUrls = new Set<string>();
  const normalized: ChatSourceRef[] = [];
  for (const candidate of value) {
    const source = normalizeSourceReference(candidate);
    if (!source) return EMPTY_CHAT_SOURCE_REFS;
    if (seenUrls.has(source.url)) continue;

    seenUrls.add(source.url);
    normalized.push(Object.freeze(source));
  }

  if (normalized.length === 0) return EMPTY_CHAT_SOURCE_REFS;
  if (utf8ByteLength(serializeSourcePayload(normalized)) > MAX_CHAT_SOURCE_REFS_SERIALIZED_BYTES) {
    return EMPTY_CHAT_SOURCE_REFS;
  }
  return Object.freeze(normalized);
}

/** Encode source metadata as one inert HTML-comment line. */
export function serializeChatSourceRefs(value: unknown): string | null {
  const refs = normalizeChatSourceRefs(value);
  if (refs.length === 0) return null;

  const marker = `${SOURCE_MARKER_PREFIX}${serializeSourcePayload(refs)}${SOURCE_MARKER_SUFFIX}`;
  return utf8ByteLength(marker) <= MAX_SOURCE_MARKER_BYTES ? marker : null;
}

/**
 * Decode one exact source-reference marker. Anything malformed, unsupported,
 * unsafe, or outside the bounded metadata schema remains ordinary text.
 */
export function parseChatSourceRefMarker(line: unknown): readonly ChatSourceRef[] | null {
  if (!isBoundedSingleLine(line, MAX_SOURCE_MARKER_BYTES)) return null;
  if (!line.startsWith(SOURCE_MARKER_PREFIX) || !line.endsWith(SOURCE_MARKER_SUFFIX)) return null;

  const serialized = line.slice(
    SOURCE_MARKER_PREFIX.length,
    line.length - SOURCE_MARKER_SUFFIX.length
  );
  if (serialized.length === 0 || serialized.includes("-->")) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized) as unknown;
  } catch {
    return null;
  }

  const refs = parsePersistedSourceRefs(decoded);
  return refs.length > 0 ? refs : null;
}

/**
 * Escape a message line that is indistinguishable from a valid metadata
 * marker. The wrapper is still inert and only decodes when its inner value is
 * a valid source marker.
 */
export function escapeChatSourceMarkerLiteral(line: string): string {
  if (parseChatSourceRefMarker(line) === null) return line;

  const serialized = escapeCommentTerminators(JSON.stringify(line));
  const escaped = `${SOURCE_LITERAL_PREFIX}${serialized}${SOURCE_MARKER_SUFFIX}`;
  return utf8ByteLength(escaped) <= MAX_SOURCE_LITERAL_BYTES ? escaped : line;
}

/** Decode one literal source-marker frame, or return null for ordinary text. */
export function parseChatSourceMarkerLiteral(line: unknown): string | null {
  if (!isBoundedSingleLine(line, MAX_SOURCE_LITERAL_BYTES)) return null;
  if (!line.startsWith(SOURCE_LITERAL_PREFIX) || !line.endsWith(SOURCE_MARKER_SUFFIX)) {
    return null;
  }

  const serialized = line.slice(
    SOURCE_LITERAL_PREFIX.length,
    line.length - SOURCE_MARKER_SUFFIX.length
  );
  if (serialized.length === 0 || serialized.includes("-->")) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized) as unknown;
  } catch {
    return null;
  }
  return typeof decoded === "string" && parseChatSourceRefMarker(decoded) !== null ? decoded : null;
}

function normalizeSourceReference(value: unknown): ChatSourceRef | null {
  if (!isPlainRecord(value)) return null;
  if (value.kind !== undefined && value.kind !== "web") return null;

  let source: SourceReference | null;
  try {
    source = toWebSourceReference(value);
  } catch {
    return null;
  }
  if (!source?.url) return null;
  const url = normalizePublicUrl(source.url);
  if (!url) return null;

  return {
    title: source.title,
    url,
    ...(source.snippet !== undefined ? { snippet: source.snippet } : {}),
    ...(source.publishedAt !== undefined ? { publishedAt: source.publishedAt } : {}),
  };
}

function parsePersistedSourceRefs(value: unknown): readonly ChatSourceRef[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHAT_SOURCE_REFS) {
    return EMPTY_CHAT_SOURCE_REFS;
  }

  const seenUrls = new Set<string>();
  const normalized: ChatSourceRef[] = [];
  for (const candidate of value) {
    if (!isStrictPersistedSource(candidate)) return EMPTY_CHAT_SOURCE_REFS;

    let source: SourceReference | null;
    try {
      source = toWebSourceReference(candidate);
    } catch {
      return EMPTY_CHAT_SOURCE_REFS;
    }
    if (!source?.url) {
      return EMPTY_CHAT_SOURCE_REFS;
    }
    const url = normalizePublicUrl(source.url);
    if (!url) {
      return EMPTY_CHAT_SOURCE_REFS;
    }

    const ref: ChatSourceRef = {
      title: candidate.title,
      url,
      ...(candidate.snippet !== undefined ? { snippet: candidate.snippet } : {}),
      ...(candidate.publishedAt !== undefined ? { publishedAt: candidate.publishedAt } : {}),
    };
    if (seenUrls.has(ref.url)) continue;
    seenUrls.add(ref.url);
    normalized.push(Object.freeze(ref));
  }

  if (normalized.length === 0) return EMPTY_CHAT_SOURCE_REFS;
  if (utf8ByteLength(serializeSourcePayload(normalized)) > MAX_CHAT_SOURCE_REFS_SERIALIZED_BYTES) {
    return EMPTY_CHAT_SOURCE_REFS;
  }
  return Object.freeze(normalized);
}

function isStrictPersistedSource(value: unknown): value is ChatSourceRef {
  if (!isPlainRecord(value)) return false;

  const keys = Object.keys(value);
  const allowedKeys = new Set(["title", "url", "snippet", "publishedAt"]);
  if (
    keys.length < 2 ||
    !keys.includes("title") ||
    !keys.includes("url") ||
    keys.some((key) => !allowedKeys.has(key))
  ) {
    return false;
  }

  if (!isBoundedString(value.title, MAX_SOURCE_TITLE_LENGTH)) return false;
  if (!isBoundedString(value.url, 2_048)) return false;
  if (
    ("snippet" in value && !isBoundedString(value.snippet, MAX_SOURCE_SNIPPET_LENGTH)) ||
    ("publishedAt" in value && !isBoundedString(value.publishedAt, MAX_SOURCE_PUBLISHED_AT_LENGTH))
  ) {
    return false;
  }
  return true;
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isBoundedSingleLine(value: unknown, maxBytes: number): value is string {
  if (typeof value !== "string" || value.length > maxBytes) return false;
  if (
    value.includes("\n") ||
    value.includes("\r") ||
    value.includes("\u2028") ||
    value.includes("\u2029")
  ) {
    return false;
  }
  return utf8ByteLength(value) <= maxBytes;
}

function serializeSourcePayload(value: readonly ChatSourceRef[]): string {
  return escapeCommentTerminators(JSON.stringify(value));
}

function escapeCommentTerminators(value: string): string {
  return value
    .replaceAll("-->", "--\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
