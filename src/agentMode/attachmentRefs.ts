/** The only attachment metadata that an Agent Mode chat may retain. */
export interface LocalAttachmentRef {
  readonly schemaVersion: typeof CHAT_ATTACHMENT_REF_SCHEMA_VERSION;
  readonly vaultId: string;
  readonly attachmentId: string;
}

/** Version of the optional chat attachment-reference envelope. */
export const CHAT_ATTACHMENT_REF_SCHEMA_VERSION = 1 as const;

/** Maximum number of attachment references retained on one message. */
export const MAX_CHAT_ATTACHMENT_REFS = 16;

/** Maximum length of a single descriptive vault identity. */
export const MAX_CHAT_ATTACHMENT_VAULT_ID_LENGTH = 256;

/** Maximum length of the opaque store identity accepted in chat metadata. */
export const MAX_CHAT_ATTACHMENT_ID_LENGTH = 128;

/** Maximum UTF-8 size of the JSON reference array, excluding its marker. */
export const MAX_CHAT_ATTACHMENT_REFS_SERIALIZED_BYTES = 4096;

const ATTACHMENT_MARKER_PREFIX = "<!-- copilot-local-attachment-refs:v1;metadata ";
const ATTACHMENT_MARKER_SUFFIX = " -->";
const ATTACHMENT_LITERAL_PREFIX = "<!-- copilot-local-attachment-refs:v1;literal ";
const MAX_ATTACHMENT_MARKER_BYTES =
  MAX_CHAT_ATTACHMENT_REFS_SERIALIZED_BYTES +
  ATTACHMENT_MARKER_PREFIX.length +
  ATTACHMENT_MARKER_SUFFIX.length;
const MAX_ATTACHMENT_LITERAL_BYTES = MAX_ATTACHMENT_MARKER_BYTES * 2;

const EMPTY_LOCAL_ATTACHMENT_REFS: readonly LocalAttachmentRef[] = Object.freeze([]);

/**
 * Normalize untrusted chat metadata to the fixed, bounded envelope.
 *
 * Invalid input is discarded as a whole. This keeps a malformed or oversized
 * value from being partially interpreted as a restore capability. Duplicate
 * `(vaultId, attachmentId)` pairs are removed while preserving first-seen
 * order. The returned objects and array are immutable snapshots.
 */
export function normalizeLocalAttachmentRefs(value: unknown): readonly LocalAttachmentRef[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHAT_ATTACHMENT_REFS) {
    return EMPTY_LOCAL_ATTACHMENT_REFS;
  }

  const seen = new Set<string>();
  const normalized: LocalAttachmentRef[] = [];
  for (const candidate of value) {
    if (!isPlainRecord(candidate)) return EMPTY_LOCAL_ATTACHMENT_REFS;

    const keys = Object.keys(candidate);
    if (
      keys.length !== 3 ||
      !keys.includes("schemaVersion") ||
      !keys.includes("vaultId") ||
      !keys.includes("attachmentId")
    ) {
      return EMPTY_LOCAL_ATTACHMENT_REFS;
    }

    if (
      candidate.schemaVersion !== CHAT_ATTACHMENT_REF_SCHEMA_VERSION ||
      !isVaultId(candidate.vaultId) ||
      !isAttachmentId(candidate.attachmentId)
    ) {
      return EMPTY_LOCAL_ATTACHMENT_REFS;
    }

    const vaultId = candidate.vaultId;
    const attachmentId = candidate.attachmentId;
    const identity = `${vaultId}\u0000${attachmentId}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    normalized.push(
      Object.freeze({
        schemaVersion: CHAT_ATTACHMENT_REF_SCHEMA_VERSION,
        vaultId,
        attachmentId,
      })
    );
  }

  if (normalized.length === 0) return EMPTY_LOCAL_ATTACHMENT_REFS;
  const serialized = JSON.stringify(normalized);
  if (utf8ByteLength(serialized) > MAX_CHAT_ATTACHMENT_REFS_SERIALIZED_BYTES) {
    return EMPTY_LOCAL_ATTACHMENT_REFS;
  }
  return Object.freeze(normalized);
}

/**
 * Encode valid metadata as one inert Markdown comment line.
 *
 * The comment carries identifiers only; it is never read as a permission
 * grant and never contains bytes, paths, URLs, or source capabilities.
 */
export function serializeLocalAttachmentRefs(value: unknown): string | null {
  const refs = normalizeLocalAttachmentRefs(value);
  if (refs.length === 0) return null;

  const serialized = JSON.stringify(refs);
  const marker = `${ATTACHMENT_MARKER_PREFIX}${serialized}${ATTACHMENT_MARKER_SUFFIX}`;
  return utf8ByteLength(marker) <= MAX_ATTACHMENT_MARKER_BYTES ? marker : null;
}

/**
 * Decode one exact marker line. A non-marker, malformed, unknown-version, or
 * spoofed line returns null so ordinary message text remains ordinary text.
 */
export function parseLocalAttachmentRefMarker(line: unknown): readonly LocalAttachmentRef[] | null {
  if (typeof line !== "string" || !line.startsWith(ATTACHMENT_MARKER_PREFIX)) return null;
  if (!line.endsWith(ATTACHMENT_MARKER_SUFFIX)) return null;
  // Reject an oversized character sequence before TextEncoder allocates a
  // byte buffer for it. The byte check below still rejects multibyte overflow.
  if (line.length > MAX_ATTACHMENT_MARKER_BYTES) return null;
  if (utf8ByteLength(line) > MAX_ATTACHMENT_MARKER_BYTES) return null;

  const serialized = line.slice(
    ATTACHMENT_MARKER_PREFIX.length,
    line.length - ATTACHMENT_MARKER_SUFFIX.length
  );
  if (serialized.length === 0) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized) as unknown;
  } catch {
    return null;
  }
  const refs = normalizeLocalAttachmentRefs(decoded);
  return refs.length > 0 ? refs : null;
}

/**
 * Escape a message line that would otherwise be mistaken for metadata.
 *
 * Message text and optional metadata share one Markdown body, so a valid
 * metadata-shaped line typed by a user needs an explicit text frame before the
 * body is persisted. Non-matching lines are returned unchanged.
 */
export function escapeLocalAttachmentMarkerLiteral(line: string): string {
  if (parseLocalAttachmentRefMarker(line) === null) return line;

  // A valid metadata marker cannot contain the comment terminator because its
  // identifiers reject it. Keep the escaping rule explicit for future marker
  // changes so a literal frame cannot terminate its own HTML comment.
  const serialized = JSON.stringify(line).replaceAll("-->", "--\\u003e");
  const escaped = `${ATTACHMENT_LITERAL_PREFIX}${serialized}${ATTACHMENT_MARKER_SUFFIX}`;
  return utf8ByteLength(escaped) <= MAX_ATTACHMENT_LITERAL_BYTES ? escaped : line;
}

/** Decode one literal text frame, or return null for ordinary body text. */
export function parseLocalAttachmentMarkerLiteral(line: unknown): string | null {
  if (typeof line !== "string" || !line.startsWith(ATTACHMENT_LITERAL_PREFIX)) return null;
  if (!line.endsWith(ATTACHMENT_MARKER_SUFFIX)) return null;
  if (line.length > MAX_ATTACHMENT_LITERAL_BYTES) return null;
  if (utf8ByteLength(line) > MAX_ATTACHMENT_LITERAL_BYTES) return null;

  const serialized = line.slice(
    ATTACHMENT_LITERAL_PREFIX.length,
    line.length - ATTACHMENT_MARKER_SUFFIX.length
  );
  if (serialized.length === 0) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized) as unknown;
  } catch {
    return null;
  }
  return typeof decoded === "string" && parseLocalAttachmentRefMarker(decoded) !== null
    ? decoded
    : null;
}

function isVaultId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CHAT_ATTACHMENT_VAULT_ID_LENGTH &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- reject control bytes before marker serialization
    !/[\u0000-\u001F\u007F<>\\/]/u.test(value) &&
    !value.includes("-->")
  );
}

function isAttachmentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CHAT_ATTACHMENT_ID_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
