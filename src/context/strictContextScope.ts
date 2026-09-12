/**
 * Small, dependency-free policy leaf for explicit @file/@folder context.
 *
 * A vault path is a label, not an operating-system capability. Callers still
 * have to resolve the accepted paths through the current Vault instance before
 * reading them. This module only defines the lexical policy and the exact
 * folder-boundary semantics used at that read boundary.
 */

export type StrictContextPathKind = "file" | "folder";

export type StrictContextRejectionReason = "invalid-path" | "not-in-vault";

export interface StrictContextRejection {
  readonly kind: StrictContextPathKind;
  readonly value: string;
  readonly reason: StrictContextRejectionReason;
}

export interface StrictContextScope {
  /** Exact, already-authorized vault-relative file paths. */
  readonly filePaths: ReadonlySet<string>;
  /** Vault-relative folder paths. The empty string represents the vault root. */
  readonly folderPaths: ReadonlySet<string>;
}

export interface StrictContextScopeResult {
  readonly scope: StrictContextScope;
  readonly rejected: readonly StrictContextRejection[];
}

interface PathValue {
  readonly path?: unknown;
}

const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:/;

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Normalize one vault-relative path. Returns null instead of guessing when a
 * value could be interpreted as an absolute path or a traversal sequence.
 *
 * `allowRoot` is only for folder selections, where `/` denotes the vault root.
 * Backslashes are rejected rather than converted so a Windows path cannot be
 * silently reinterpreted on another platform.
 */
export function normalizeStrictVaultPath(
  value: unknown,
  options: { readonly allowRoot?: boolean } = {}
): string | null {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    return null;
  }
  const allowRoot = options.allowRoot === true;
  if (allowRoot && value === "/") {
    return "";
  }
  if (containsControlCharacter(value) || value.includes("\\")) {
    return null;
  }
  if (value.startsWith("/") || WINDOWS_ABSOLUTE_PATH_RE.test(value)) {
    return null;
  }

  // Folder pickers may return a trailing slash; normalize only that harmless
  // display detail. Interior duplicate separators remain rejected.
  const path = allowRoot ? value.replace(/\/$/, "") : value;
  if (path.length === 0 || path.includes("//")) {
    return null;
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment.length === 0)) {
    return null;
  }

  return segments.join("/");
}

/** Extract a path from a TFile/TFolder-like value without trusting its shape. */
function extractPath(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return null;
  const path = (value as PathValue).path;
  return typeof path === "string" ? path : null;
}

function rejectedValue(value: unknown): string {
  const path = extractPath(value);
  return path ?? "<invalid>";
}

/**
 * Build a strict scope from the current vault inventory and the user's
 * explicit selections. Unknown/stale file references are rejected; a valid
 * folder may simply contain no supported files yet and therefore remains a
 * harmless empty scope.
 */
export function buildStrictContextScope(
  requestedFiles: readonly unknown[],
  requestedFolders: readonly unknown[],
  availableFilePaths: readonly string[]
): StrictContextScopeResult {
  const available = new Set<string>();
  for (const path of availableFilePaths) {
    const normalized = normalizeStrictVaultPath(path);
    if (normalized !== null) available.add(normalized);
  }

  const filePaths = new Set<string>();
  const folderPaths = new Set<string>();
  const rejected: StrictContextRejection[] = [];

  for (const requested of requestedFiles) {
    const rawPath = extractPath(requested);
    const normalized = normalizeStrictVaultPath(rawPath);
    if (normalized === null) {
      rejected.push({
        kind: "file",
        value: rejectedValue(requested),
        reason: "invalid-path",
      });
      continue;
    }
    if (!available.has(normalized)) {
      rejected.push({
        kind: "file",
        value: normalized,
        reason: "not-in-vault",
      });
      continue;
    }
    filePaths.add(normalized);
  }

  for (const requested of requestedFolders) {
    const rawPath = extractPath(requested);
    const normalized = normalizeStrictVaultPath(rawPath, { allowRoot: true });
    if (normalized === null) {
      rejected.push({
        kind: "folder",
        value: rejectedValue(requested),
        reason: "invalid-path",
      });
      continue;
    }
    folderPaths.add(normalized);
  }

  return {
    scope: { filePaths, folderPaths },
    rejected,
  };
}

/** Whether a normalized file path is inside one of the selected folders. */
export function isPathInStrictFolderScope(
  filePath: unknown,
  folderPaths: ReadonlySet<string>
): boolean {
  const normalizedFilePath = normalizeStrictVaultPath(filePath);
  if (normalizedFilePath === null) return false;

  for (const folderPath of folderPaths) {
    if (folderPath === "" || normalizedFilePath.startsWith(`${folderPath}/`)) {
      return true;
    }
  }
  return false;
}

/** Whether a file is allowed by either an exact file selection or a folder. */
export function isPathInStrictContextScope(filePath: unknown, scope: StrictContextScope): boolean {
  const normalizedFilePath = normalizeStrictVaultPath(filePath);
  if (normalizedFilePath === null) return false;
  return (
    scope.filePaths.has(normalizedFilePath) ||
    isPathInStrictFolderScope(normalizedFilePath, scope.folderPaths)
  );
}

/** Filter current-vault file objects without changing their order. */
export function filterFilesToStrictContext<T extends { readonly path: string }>(
  files: readonly T[],
  scope: StrictContextScope
): T[] {
  return files.filter((file) => isPathInStrictContextScope(file.path, scope));
}

/** Filter current-vault file objects to folder-selected content only. */
export function filterFilesToStrictFolders<T extends { readonly path: string }>(
  files: readonly T[],
  folderPaths: ReadonlySet<string>
): T[] {
  return files.filter((file) => isPathInStrictFolderScope(file.path, folderPaths));
}
