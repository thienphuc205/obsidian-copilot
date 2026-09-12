/**
 * Vault-selection sandbox scope for Agent Mode.
 *
 * Computes the writable-area contract (`AgentScope`) behind the
 * `agentScopeMode: "selected-context"` setting from the explicit @note/@folder
 * selection a user attaches to their first turn. The lexical policy (which
 * paths count, which are dropped) is reused from `context/strictContextScope`
 * so a chat selection and the sandbox can never disagree about what was
 * selected; this module only adds the absolute-folder projection and the
 * workspace-root math the backends consume.
 *
 * A vault path is a label, not an operating-system capability: like the strict
 * scope, this module never touches the filesystem. Callers resolve the result
 * through the live vault (cwd for the ACP backends, enforcement for the SDK
 * adapter) before any privilege follows from it.
 */

import { buildStrictContextScope } from "@/context/strictContextScope";

/**
 * The selection-derived sandbox for one agent session. All sets are
 * vault-relative except `absoluteFolders`, which is the same folder list
 * anchored at the vault root for consumers that need absolute paths (the ACP
 * session cwd). Empty sets mean the dimension contributed nothing.
 */
export interface AgentScope {
  /** Exact, already-resolved vault-relative file paths of the selection. */
  readonly vaultRelativeFiles: ReadonlySet<string>;
  /** Vault-relative folder prefixes; the empty string is the vault root. */
  readonly vaultRelativeFolders: ReadonlySet<string>;
  /** Each selected folder as an absolute path under `vaultRoot`. */
  readonly absoluteFolders: ReadonlySet<string>;
}

export interface AgentScopeInput {
  /** Selected notes; only the `path` property is read (TFile-compatible). */
  contextNotes?: ReadonlyArray<{ readonly path?: string }>;
  /** Selected folders as vault-relative paths (trailing slash tolerated). */
  contextFolders?: ReadonlyArray<string>;
}

export interface ComputeAgentScopeOptions {
  /**
   * Current vault-relative file paths the vault inventory knows. When given,
   * note paths are resolved against it and stale references are dropped; when
   * omitted, the provided note paths are themselves treated as the inventory
   * (only lexically-unsafe paths are dropped).
   */
  availableFilePaths?: ReadonlyArray<string>;
}

/**
 * Build the sandbox scope from a first turn's explicit selection, or `null`
 * when the selection is empty — the vault-wide default. File paths that are
 * stale (absent from the inventory) or lexically unsafe (absolute, traversal,
 * backslash) are filtered out rather than guessed at; folder references are
 * kept as prefixes, so a valid folder that contains no files yet is a harmless
 * empty scope.
 */
export function computeAgentScope(
  input: AgentScopeInput,
  vaultRoot: string,
  options: ComputeAgentScopeOptions = {}
): AgentScope | null {
  const notes = input.contextNotes ?? [];
  const folders = input.contextFolders ?? [];
  if (notes.length === 0 && folders.length === 0) return null;

  const inventory =
    options.availableFilePaths ??
    notes.flatMap((note) => (typeof note?.path === "string" ? [note.path] : []));
  const { scope } = buildStrictContextScope(notes, folders, inventory);

  const { filePaths, folderPaths } = scope;
  if (filePaths.size === 0 && folderPaths.size === 0) return null;

  const absoluteFolders = new Set<string>();
  for (const folder of folderPaths) {
    absoluteFolders.add(joinVaultFolder(vaultRoot, folder));
  }
  return {
    vaultRelativeFiles: new Set(filePaths),
    vaultRelativeFolders: new Set(folderPaths),
    absoluteFolders,
  };
}

/**
 * The workspace root the ACP backends should open a scoped session in: the
 * deepest common ancestor of the selected folders. One folder → that folder;
 * several → their common ancestor; no folders (files-only) → the vault root,
 * which is the natural cwd and therefore no narrowing at all.
 */
export function agentScopeWorkspaceRoot(scope: AgentScope, vaultRoot: string): string {
  const common = agentScopeWorkspaceFolderRoot(scope);
  return common === "" ? vaultRoot : joinVaultFolder(vaultRoot, common);
}

/**
 * The vault-relative form of {@link agentScopeWorkspaceRoot}, where `""` is
 * the vault root. Exposed for callers that compare against vault-relative
 * project paths.
 */
export function agentScopeWorkspaceFolderRoot(scope: AgentScope): string {
  const folders = Array.from(scope.vaultRelativeFolders);
  if (folders.length === 0) return "";
  if (folders.includes("")) return "";
  let prefix = folders[0].split("/");
  for (const folder of folders.slice(1)) {
    const segments = folder.split("/");
    const keep: string[] = [];
    for (let i = 0; i < Math.min(prefix.length, segments.length); i++) {
      if (prefix[i] !== segments[i]) break;
      keep.push(prefix[i]);
    }
    prefix = keep;
    if (prefix.length === 0) return "";
  }
  return prefix.join("/");
}

/** The sticky, backend-wide view of the latest selection. Spawn-time consumers
 * (the codex `CODEX_CONFIG` env and the opencode `OPENCODE_CONFIG_CONTENT`
 * payload) build their sandbox once per subprocess and have no per-session
 * channel, so they read the latest selection the manager recorded — the same
 * module-singleton access pattern as `getSettings()`. Per-session truth stays
 * on the session record (`AgentSession.getAgentScope`), which per-turn
 * consumers read instead.
 */
let activeAgentScope: AgentScope | null = null;

/** Publish the latest first-turn selection (or `null` to clear). */
export function setActiveAgentScope(scope: AgentScope | null): void {
  activeAgentScope = scope;
}

/** Latest published selection, or `null` when nothing has been selected yet. */
export function getActiveAgentScope(): AgentScope | null {
  return activeAgentScope;
}

/**
 * Canonical selection identity, ignoring Set identity: two computations over
 * the same selection must compare equal so callers (backend restarts) react
 * to a CHANGED selection, not to fresh Set allocations.
 */
export function agentScopeSignature(scope: AgentScope): string {
  return [
    Array.from(scope.vaultRelativeFolders).sort().join("|"),
    Array.from(scope.vaultRelativeFiles).sort().join("|"),
  ].join("::");
}

/** Join one vault-relative folder under an absolute vault root. */
function joinVaultFolder(vaultRoot: string, folder: string): string {
  const base = vaultRoot.replace(/[/\\]+$/, "");
  return folder === "" ? base : `${base}/${folder}`;
}
