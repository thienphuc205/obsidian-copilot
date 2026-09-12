import { normalizeStrictVaultPath } from "@/context/strictContextScope";

/** Stable source categories understood by the Source Inspector. */
export type SourceReferenceKind = "vault" | "web";

/**
 * Citation metadata shared by legacy local-search sources and future
 * page/line-aware document sources. Optional fields keep old persisted chats
 * and existing search producers source-compatible.
 */
export interface SourceReference {
  title: string;
  /** Vault-relative path for local sources, or a legacy URL for web sources. */
  path: string;
  score: number;
  explanation?: unknown;
  kind?: SourceReferenceKind;
  /** Explicit URL for web sources; `path` remains the legacy fallback. */
  url?: string;
  /** Provider-provided excerpt for a web citation, when available. */
  snippet?: string;
  /** Provider-provided publication timestamp, when available. */
  publishedAt?: string;
  /** One-based PDF page number. */
  page?: number;
  /** One-based Markdown/text line number. */
  line?: number;
  /** Optional one-based end line for a highlighted source range. */
  endLine?: number;
}

export interface VaultSourceInspectorTarget {
  readonly kind: "vault";
  readonly path: string;
  readonly anchor?: string;
  readonly page?: number;
  readonly line?: number;
  readonly endLine?: number;
}

export interface WebSourceInspectorTarget {
  readonly kind: "web";
  readonly url: string;
}

export type SourceInspectorTarget = VaultSourceInspectorTarget | WebSourceInspectorTarget;

/** Citation metadata accepted from a BYOK web provider or a backend bridge. */
export interface WebSourceMetadata {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
}

const MAX_WEB_SOURCE_TITLE_LENGTH = 300;
const MAX_WEB_SOURCE_SNIPPET_LENGTH = 2_000;
const MAX_WEB_SOURCE_PUBLISHED_AT_LENGTH = 128;

/**
 * Convert one untrusted provider source into the shared citation contract.
 * The zero score is intentional: web providers own ranking, while the legacy
 * modal's numeric score is a local-retrieval concept.
 */
export function toWebSourceReference(value: unknown): SourceReference | null {
  if (!isRecord(value)) return null;
  const title = readBoundedString(value.title, MAX_WEB_SOURCE_TITLE_LENGTH);
  const url = isSafeSourceUrl(value.url) ? value.url : null;
  if (!title || !url) return null;

  const snippet = readOptionalBoundedString(value.snippet, MAX_WEB_SOURCE_SNIPPET_LENGTH);
  const publishedAt = readOptionalBoundedString(
    value.publishedAt,
    MAX_WEB_SOURCE_PUBLISHED_AT_LENGTH
  );
  return {
    title,
    path: url,
    score: 0,
    kind: "web",
    url,
    ...(snippet === null ? {} : { snippet }),
    ...(publishedAt === null ? {} : { publishedAt }),
  };
}

/**
 * Resolve one persisted/produced source into a safe inspector target.
 *
 * This function deliberately does not access the filesystem. The caller must
 * still verify a vault target with the current Vault before opening it.
 */
export function resolveSourceInspectorTarget(
  source: SourceReference | null | undefined
): SourceInspectorTarget | null {
  if (!source || typeof source !== "object") return null;

  const candidateUrl = typeof source.url === "string" ? source.url : source.path;
  if (source.kind === "web" || (source.kind === undefined && isSafeSourceUrl(candidateUrl))) {
    const url = isSafeSourceUrl(candidateUrl) ? candidateUrl : null;
    return url ? { kind: "web", url } : null;
  }

  if (source.kind !== undefined && source.kind !== "vault") return null;
  if (typeof source.path !== "string") return null;

  const { pathPart, rawAnchor } = splitSourceAnchor(source.path);
  const path = normalizeStrictVaultPath(pathPart);
  if (path === null) return null;

  const anchor = normalizeSourceAnchor(rawAnchor);
  if (rawAnchor && anchor === null) return null;

  const page = readPositiveInteger(source.page);
  const line = readPositiveInteger(source.line);
  const endLine = readPositiveInteger(source.endLine);
  if (page === null || line === null || endLine === null) return null;
  if (line !== undefined && endLine !== undefined && endLine < line) return null;

  return {
    kind: "vault",
    path,
    ...(anchor ? { anchor } : {}),
    ...(page !== undefined ? { page } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
  };
}

/** Return whether a URL is safe to hand to an external browser window. */
export function isSafeSourceUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch {
    return false;
  }
}

function splitSourceAnchor(value: string): { pathPart: string; rawAnchor: string } {
  const hashIndex = value.indexOf("#");
  if (hashIndex < 0) return { pathPart: value, rawAnchor: "" };
  return { pathPart: value.slice(0, hashIndex), rawAnchor: value.slice(hashIndex) };
}

function normalizeSourceAnchor(value: string): string | null {
  if (!value) return "";
  if (value.length > 500 || containsControlCharacter(value)) return null;

  const body = value.slice(1);
  if (!body || body.includes("#")) return null;
  if (body.startsWith("page=")) {
    const page = Number(body.slice("page=".length));
    if (!Number.isInteger(page) || page < 1) return null;
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function readPositiveInteger(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readBoundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}

function readOptionalBoundedString(value: unknown, maxLength: number): string | null {
  if (value === undefined) return null;
  return readBoundedString(value, maxLength);
}
