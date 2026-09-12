/**
 * Bridge between the Claude SDK's `canUseTool` callback and Agent Mode's
 * session-domain prompters. Each `canUseTool` invocation is translated to a
 * `PermissionPrompt`, dispatched through the permission prompter, then
 * translated back to a SDK `PermissionResult`. AskUserQuestion gets a separate
 * branch that dispatches through the ask-question prompter — the session
 * surfaces a card in the action rail and returns the answers map.
 */
import type {
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentQuestion,
  AgentQuestionAnswers,
  AskUserQuestionPrompt,
  PermissionDecision,
  PermissionOption,
  PermissionOptionKind,
  PermissionPrompt,
  SessionId,
} from "@/agentMode/session/types";
import { PERMISSION_OPTION_KINDS } from "@/agentMode/session/types";
import { resolveToolName } from "@/agentMode/session/toolName";
import { isVaultWriteToolKind } from "@/agentMode/session/fanout/fanoutTypes";
import { isAbsolutePath } from "@/utils/vaultPath";
import { err2String } from "@/utils";
import { logSdkInbound, logSdkOutbound } from "./sdkDebugTap";
import { deriveToolKind, deriveToolTitle, vendorMetaFields } from "./toolMeta";

export type Prompter = (req: PermissionPrompt) => Promise<PermissionDecision>;

/**
 * Session-domain handler for the SDK's `AskUserQuestion` tool. Mirrors the
 * permission `Prompter`: the bridge fetches it lazily via
 * `getAskUserQuestionPrompter` so it can be registered after construction.
 */
export type AskUserQuestionPrompter = (req: AskUserQuestionPrompt) => Promise<AgentQuestionAnswers>;

type InProcessCanUseTool = (...args: Parameters<CanUseTool>) => Promise<PermissionResult>;

/**
 * Structural mirror of `AgentScope` (`agentMode/session/agentScope.ts`) so the
 * SDK layer can gate tool calls without importing the session-layer type,
 * which is being added by the scope-plumbing workstream. The session manager
 * hands an `AgentScope` straight through; anything with these members
 * satisfies this shape.
 */
export interface ScopeSandbox {
  vaultRelativeFiles?: Iterable<string>;
  vaultRelativeFolders?: ReadonlySet<string>;
  absoluteFolders?: ReadonlySet<string>;
  /**
   * Absolute vault root used to normalize absolute tool paths into
   * vault-relative ones. Supplied by the backend process (which knows the
   * vault base) alongside the session's scope; absent only in tests.
   */
  vaultRoot?: string;
}

/** The message sent for any write tool call targeting a path outside the scope. */
export const SCOPE_SANDBOX_DENY_MESSAGE =
  "Outside the selected context scope for this session — enable more context or turn off the Agent scope sandbox.";

/** SDK-side shape of the `AskUserQuestion` tool input. */
export interface AskUserQuestionInput {
  questions: AgentQuestion[];
}

export interface PermissionBridgeOptions {
  getPrompter: () => Prompter | null;
  /**
   * Lazily fetch the session-domain ask-question prompter. Absent / returning
   * `null` makes AskUserQuestion deny with "not yet supported", matching the
   * pre-inline behavior when no handler was wired.
   */
  getAskUserQuestionPrompter?: () => AskUserQuestionPrompter | null;
  /**
   * Predicate identifying plan-mode plan files. When provided, the bridge
   * auto-allows `Write` calls whose `file_path` satisfies the predicate so
   * plan mode can finalize its proposal at `~/.claude/plans/*.md` without
   * a prompt. Every other `Write` is routed through the permission
   * prompter like any other tool.
   */
  isPlanModePlanFilePath?: (absolutePath: string) => boolean;
  /**
   * Lazily fetch the predicate deciding whether a backend session is an
   * ephemeral read-only fan-out QA sub-session. Lazy (like `getPrompter`) so
   * the manager can register it after the backend is constructed. Consulted at
   * the TOP of `canUseTool`, BEFORE the plan-file auto-allow: a read-only
   * session hard-denies every write/exec tool (including plan-file `Write`s) so
   * the auto-allow can never reopen a write path during a read-only QA turn.
   * Closes the hole generically even if a mode switch failed to sandbox the
   * backend.
   */
  getIsReadOnlySession?: () => ((sessionId: SessionId) => boolean) | null;
  /**
   * Selected-context sandbox (`agentScopeMode: "selected-context"`): when the
   * session carries a scope, `Write`/`Edit`/`NotebookEdit` calls whose target
   * path resolves outside the selected files/folders are hard-denied. Reads,
   * Bash, and search tools are untouched (read stays broad by design; Bash
   * already routes through the prompter). Checked AFTER the read-only
   * hard-deny and the plan-file auto-allow — plan files live under
   * `~/.claude/plans/`, outside any vault scope, so the plan predicate must
   * keep winning for its own paths.
   *
   * Lazy like the other getters so the manager can register it after the
   * backend is constructed. `undefined` / `null` / mode-off → no gating and
   * byte-identical behavior to a bridge without this option.
   */
  getScopeSandbox?: () => ScopeSandbox | null | undefined;
}

/** Translates Claude tool requests for one immutable backend session. */
export class PermissionBridge {
  constructor(
    private readonly sessionId: SessionId,
    private readonly opts: PermissionBridgeOptions
  ) {}

  // This bridge always sends its response through the SDK. The upstream
  // nullable return is reserved for hosts that answered out of band.
  canUseTool: InProcessCanUseTool = async (toolName, input, ctx) => {
    if (toolName === "AskUserQuestion") {
      return this.handleAskUserQuestion(input as unknown as AskUserQuestionInput, ctx);
    }

    const sessionId = this.sessionId;
    logSdkInbound(
      `canUseTool:request`,
      { toolName, input, suggestions: ctx.suggestions },
      sessionId
    );

    // Read-only fan-out QA sub-sessions hard-deny writes/exec BEFORE the
    // plan-file auto-allow below, so a read-only turn can never finalize a
    // plan file (or any other write) even if the sandbox mode switch was wrong
    // for this backend. Reads/searches/fetches fall through to the normal path
    // (the prompter then allows them).
    const isReadOnlySession = this.opts.getIsReadOnlySession?.();
    if (sessionId && isReadOnlySession?.(sessionId)) {
      const { tool, mcpServer } = resolveToolName(toolName);
      const kind = deriveToolKind(tool, mcpServer);
      // An MCP tool whose name isn't a known built-in derives to `other`, which
      // is otherwise allowed. We can't verify a third-party MCP tool is
      // read-only (e.g. `mcp__filesystem__write_file`), so fail safe and deny
      // unknown MCP tools in a read-only QA turn; known-classified MCP reads
      // (read/search/fetch) still fall through.
      const isUnverifiableMcpTool = Boolean(mcpServer) && kind === "other";
      if (isVaultWriteToolKind(kind) || isUnverifiableMcpTool) {
        return this.deny(
          "canUseTool:response",
          "Read-only QA turn: vault-write tools are disabled.",
          sessionId
        );
      }
    }

    if (toolName === "Write") {
      const filePath = typeof input.file_path === "string" ? input.file_path : null;
      if (filePath && this.opts.isPlanModePlanFilePath?.(filePath)) {
        const result: PermissionResult = { behavior: "allow", updatedInput: input };
        logSdkOutbound("canUseTool:response:auto-allow-plan", result, sessionId);
        return result;
      }
    }

    // Selected-context sandbox: deny write-tool calls aimed outside the scope.
    // Runs after the read-only hard-deny and the plan-file auto-allow (plan
    // files sit outside any vault scope, so the plan predicate must keep
    // winning for its own paths) and before the prompter fallback.
    if (toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") {
      const targetPath =
        typeof input.file_path === "string"
          ? input.file_path
          : typeof input.notebook_path === "string"
            ? input.notebook_path
            : null;
      if (targetPath && isOutsideScope(targetPath, this.opts.getScopeSandbox?.() ?? null)) {
        return this.deny("canUseTool:response", SCOPE_SANDBOX_DENY_MESSAGE, sessionId);
      }
    }

    const prompter = this.opts.getPrompter();
    if (!prompter) {
      return this.deny("canUseTool:response", "No permission prompter available", sessionId);
    }
    const prompt = synthesizePermissionPrompt(toolName, input, sessionId, ctx);
    const decision = await prompter(prompt);
    const result = mapDecisionToSdk(decision, ctx.suggestions, input);
    logSdkOutbound("canUseTool:response", result, sessionId);
    return result;
  };

  private async handleAskUserQuestion(
    input: AskUserQuestionInput,
    ctx: Parameters<CanUseTool>[2]
  ): Promise<PermissionResult> {
    const sessionId = this.sessionId;
    logSdkInbound("askUserQuestion:request", input, sessionId);
    const prompter = this.opts.getAskUserQuestionPrompter?.() ?? null;
    if (!prompter) {
      return this.deny(
        "askUserQuestion:response",
        "AskUserQuestion is not yet supported",
        sessionId
      );
    }
    try {
      // Reuse the SDK's `tool_use_id` as the requestId so the inline card's
      // resolver pairs the answer with this call, mirroring the permission
      // prompt's `toolCallId`.
      const answers = await prompter({
        sessionId,
        requestId: ctx.toolUseID,
        questions: input.questions,
      });
      if (Object.keys(answers).length === 0) {
        return this.deny("askUserQuestion:response", "User cancelled the question", sessionId);
      }
      const result: PermissionResult = {
        behavior: "allow",
        updatedInput: { questions: input.questions, answers },
      };
      logSdkOutbound("askUserQuestion:response", result, sessionId);
      return result;
    } catch (e) {
      return this.deny(
        "askUserQuestion:response",
        `AskUserQuestion failed: ${err2String(e)}`,
        sessionId
      );
    }
  }

  private deny(method: string, message: string, sessionId: SessionId): PermissionResult {
    const result: PermissionResult = { behavior: "deny", message };
    logSdkOutbound(method, result, sessionId);
    return result;
  }
}

const STANDARD_OPTION_NAMES: Record<PermissionOptionKind, string> = {
  allow_once: "Allow once",
  allow_always: "Allow always",
  reject_once: "Deny once",
  reject_always: "Deny always",
};

/**
 * True when `targetPath` resolves OUTSIDE the selected-context sandbox, i.e.
 * it is neither a selected file, nor inside a selected folder, nor under an
 * absolute folder root. Absolute paths are normalized against `vaultRoot`
 * (forward slashes, trailing separators stripped) so `/vault/notes/a.md` and
 * `notes/a.md` compare equal; segment-boundary matching prevents
 * `/vault-other/x` from passing as `/vault/x`. No scope → not outside, so the
 * bridge behaves exactly as before the option existed. An absolute path that
 * cannot be resolved against the vault root is only contained by
 * `absoluteFolders` — anything else is outside (fail closed: the sandbox
 * exists to stop unselected writes).
 */
function isOutsideScope(targetPath: string, sandbox: ScopeSandbox | null): boolean {
  if (!sandbox) return false;
  const rel = normalizeVaultRelative(targetPath, sandbox.vaultRoot ?? null);
  if (rel === null) {
    // Not resolvable against the vault root (or no root): only absolute folder
    // roots can still contain it.
    const abs = normalizeSlashes(targetPath);
    return !isUnderAny(abs, sandbox.absoluteFolders);
  }
  if (isUnderAny(rel, sandbox.vaultRelativeFiles)) return false;
  if (isUnderAny(rel, sandbox.vaultRelativeFolders)) return false;
  const abs = sandbox.vaultRoot
    ? `${normalizeSlashes(sandbox.vaultRoot)}/${rel}`
    : normalizeSlashes(targetPath);
  return !isUnderAny(abs, sandbox.absoluteFolders);
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Convert an absolute target path into a forward-slashed vault-relative path.
 * Returns the path unchanged when it is already relative; returns null when it
 * is absolute but no vault root is known (or it lies outside the vault).
 */
function normalizeVaultRelative(p: string, vaultRoot: string | null): string | null {
  if (!isAbsolutePath(p)) return p;
  if (!vaultRoot) return null;
  const base = normalizeSlashes(vaultRoot);
  const norm = normalizeSlashes(p);
  if (norm === base) return "";
  if (!norm.startsWith(`${base}/`)) return null;
  return norm.slice(base.length + 1);
}

/**
 * Segment-boundary prefix match against a set of candidate roots. An empty
 * root (`""`) matches everything — an explicitly selected vault root scopes
 * in the whole vault.
 */
function isUnderAny(p: string, roots: Iterable<string> | undefined): boolean {
  if (!roots) return false;
  for (const root of roots) {
    const r = normalizeSlashes(root);
    if (r === "" || p === r || p.startsWith(`${r}/`)) return true;
  }
  return false;
}

const STANDARD_OPTIONS: PermissionOption[] = PERMISSION_OPTION_KINDS.map((kind) => ({
  optionId: kind,
  name: STANDARD_OPTION_NAMES[kind],
  kind,
}));
const STANDARD_OPTION_IDS = new Set<string>(PERMISSION_OPTION_KINDS);

function synthesizePermissionPrompt(
  toolName: string,
  input: Record<string, unknown>,
  sessionId: SessionId,
  ctx: Parameters<CanUseTool>[2]
): PermissionPrompt {
  const { tool: name, mcpServer } = resolveToolName(toolName);
  return {
    sessionId,
    toolCall: {
      // Reuse the SDK's `tool_use_id` so prompt and `tool_call` notification
      // share an id — the trail UI and plan-card resolver pair them by id.
      toolCallId: ctx.toolUseID,
      kind: deriveToolKind(name, mcpServer),
      status: "pending",
      title: deriveToolTitle(name, input, typeof ctx.title === "string" ? ctx.title : undefined),
      rawInput: input,
      mcpServer,
      ...vendorMetaFields(name, undefined, mcpServer),
    },
    options: STANDARD_OPTIONS,
  };
}

function mapDecisionToSdk(
  decision: PermissionDecision,
  suggestions: PermissionUpdate[] | undefined,
  input: Record<string, unknown>
): PermissionResult {
  if (decision.outcome.outcome === "cancelled") {
    return { behavior: "deny", message: "User cancelled" };
  }
  // Defensive default: unknown ids collapse to deny so they don't silently allow.
  const optionKind = STANDARD_OPTION_IDS.has(decision.outcome.optionId)
    ? (decision.outcome.optionId as PermissionOptionKind)
    : "reject_once";
  switch (optionKind) {
    case "allow_once":
      // SDK runtime schema requires `updatedInput` even though the type marks
      // it optional. Echo the original — we don't modify tool args from the prompt.
      return { behavior: "allow", updatedInput: input };
    case "allow_always":
      return { behavior: "allow", updatedInput: input, updatedPermissions: suggestions ?? [] };
    case "reject_once":
    case "reject_always":
      return { behavior: "deny", message: decision.denyMessage ?? "User declined" };
  }
}
