import { ConfirmModal } from "@/components/modals/ConfirmModal";
import type { App, Command, TFile } from "obsidian";
import { Notice } from "obsidian";

import {
  CHAT_ATTACHMENT_REF_SCHEMA_VERSION,
  MAX_CHAT_ATTACHMENT_REFS,
  normalizeLocalAttachmentRefs,
} from "@/agentMode/attachmentRefs";
import type { LocalAttachmentRef } from "@/agentMode/attachmentRefs";
import type {
  AgentSession,
  SessionLocalAttachmentLiveTargetGetter,
  SessionLocalAttachmentSnapshot,
  SessionLocalAttachmentStaging,
  SessionLocalAttachmentStagingError,
  SessionLocalAttachmentTarget,
} from "@/agentMode";
import type CopilotPlugin from "@/main";
import { isValidAttachmentVaultId } from "@/context/assets/attachmentStoreTypes";
import { isDesktopRuntime, requireNodeModule } from "@/utils/desktopRuntime";
import type {
  LocalImageRuntime,
  LocalImageRuntimeConfirmation,
  LocalImageRuntimeError,
  LocalImageRuntimeExecutionRequest,
  LocalImageRuntimeExecutionResult,
  LocalImageRuntimeLiveScope,
  LocalImageRuntimeOptions,
  LocalImageRuntimePreview,
  LocalImageRuntimeSelection,
} from "@/context/assets/localImageRuntime";

/** Obsidian command id for the explicit local-image preparation action. */
export const LOCAL_IMAGE_COMMAND_ID = "save-active-note-images-locally";

/** User-facing name for the explicit local-image preparation action. */
export const LOCAL_IMAGE_COMMAND_NAME = "Save active note images locally";

/** Obsidian command id for explicit Agent Chat staging. */
export const LOCAL_IMAGE_CHAT_STAGING_COMMAND_ID = "prepare-active-note-images-for-agent-chat";

/** User-facing name for explicit Agent Chat staging. */
export const LOCAL_IMAGE_CHAT_STAGING_COMMAND_NAME =
  "Prepare active note images for this Agent chat";

const LOCAL_IMAGE_COMMAND_ICON = "image-down";
const MAX_NOTE_TEXT_BYTES = 256 * 1024;
const MAX_DISPLAY_TEXT_LENGTH = 192;
const MAX_DISPLAY_CANDIDATES = 8;
const MAX_DISPLAY_COUNT = 64;
const EMPTY_LOCAL_ATTACHMENT_REFS: readonly LocalAttachmentRef[] = Object.freeze([]);

type LocalImageRuntimeFactory =
  typeof import("@/context/assets/localImageRuntime").createLocalImageRuntime;
type LocalImagePreview = LocalImageRuntimePreview;
type LocalImageConfirmation = LocalImageRuntimeConfirmation;
type LiveScope = LocalImageRuntimeLiveScope;

export type LocalImageRuntimeForCommand = LocalImageRuntime;
export type LocalImageRuntimeOptionsForCommand = LocalImageRuntimeOptions;

interface LocalImageCommandDependencies {
  readonly createRuntime?: LocalImageRuntimeFactory;
  readonly getVaultId?: () => string | Promise<string>;
  readonly getHomeDir?: () => string;
  readonly isDesktopRuntime?: () => boolean;
  readonly onRuntimeCreated?: (runtime: LocalImageRuntime) => void;
  readonly onRuntimeDisposed?: (runtime: LocalImageRuntime) => void;
}

interface ActiveNoteSnapshot {
  readonly file: TFile;
  readonly notePath: string;
  readonly scopePath: string;
}

interface ActiveAgentTargetSnapshot {
  readonly session: AgentSession;
  readonly target: SessionLocalAttachmentTarget;
}

/**
 * Create the command callback used by the plugin registration boundary.
 *
 * The command reads only bounded Markdown note text before preview. The
 * runtime is created for that invocation, and its image-byte reads and
 * off-vault writes begin only after the native confirmation callback issues a
 * one-use confirmation token.
 *
 * @param plugin - Plugin instance that owns the current Obsidian application.
 * @param dependencies - Optional seams for the runtime and synthetic tests.
 * @returns An Obsidian command descriptor with a desktop-only callback.
 */
export function createLocalImagePreparationCommand(
  plugin: CopilotPlugin,
  dependencies: LocalImageCommandDependencies = {}
): Command {
  const desktopCheck = dependencies.isDesktopRuntime ?? isDesktopRuntime;
  const createRuntime = dependencies.createRuntime ?? loadLocalImageRuntime;
  const getVaultId = dependencies.getVaultId ?? (() => loadVaultId(plugin.app));
  const getHomeDir = dependencies.getHomeDir ?? getDefaultHomeDir;

  return {
    id: LOCAL_IMAGE_COMMAND_ID,
    name: LOCAL_IMAGE_COMMAND_NAME,
    icon: LOCAL_IMAGE_COMMAND_ICON,
    callback: async () => {
      if (!desktopCheck()) {
        new Notice("Local image preparation is only available on desktop.");
        return;
      }

      const activeNote = getActiveMarkdownNote(plugin.app);
      if (!activeNote) {
        new Notice("Open an active Markdown note before preparing local images.");
        return;
      }

      let noteText: string;
      let initialScope: LiveScope;
      let runtime: LocalImageRuntime | undefined;
      const disposeOwnedRuntime = async (value: LocalImageRuntime): Promise<void> => {
        await disposeRuntime(value);
        dependencies.onRuntimeDisposed?.(value);
      };
      try {
        noteText = await readBoundedNote(plugin.app, activeNote.file);
        const getLiveScope = createLiveScope(plugin.app, getVaultId);
        initialScope = await getLiveScope();
        if (!matchesActiveNote(initialScope, activeNote)) {
          new Notice("The active note changed. Run the local image command again.");
          return;
        }

        runtime = await createRuntime({
          app: plugin.app,
          vault: plugin.app.vault,
          vaultId: initialScope.vaultId,
          homeDir: getHomeDir(),
          getLiveScope,
          isDesktopRuntime: desktopCheck,
        });
        dependencies.onRuntimeCreated?.(runtime);

        const selection: LocalImageRuntimeSelection = {
          notePath: activeNote.notePath,
          scopePath: activeNote.scopePath,
          noteText,
        };
        const preview = await runtime.preview(selection);
        await showLocalImageConfirmation(
          plugin,
          runtime,
          preview,
          initialScope,
          getLiveScope,
          disposeOwnedRuntime,
          () => {
            runtime = undefined;
          }
        );
      } catch {
        if (runtime) {
          await disposeOwnedRuntime(runtime);
        }
        new Notice("Local image preparation failed. No model or network request was made.");
      }
    },
  };
}

/**
 * Create the separate command that prepares persisted local-image references
 * for the currently active Agent Chat session.
 *
 * This command never creates a session, starts a backend, changes chat
 * history, or sends a model request. The session-owned staging bucket is
 * volatile and remains owned by the session lifecycle after this callback
 * returns.
 *
 * @param plugin - Plugin instance that owns the current Obsidian application.
 * @param dependencies - Optional seams for the runtime and synthetic tests.
 * @returns An Obsidian command descriptor with a desktop-only callback.
 */
export function createLocalImageChatStagingCommand(
  plugin: CopilotPlugin,
  dependencies: LocalImageCommandDependencies = {}
): Command {
  const desktopCheck = dependencies.isDesktopRuntime ?? isDesktopRuntime;
  const createRuntime = dependencies.createRuntime ?? loadLocalImageRuntime;
  const getVaultId = dependencies.getVaultId ?? (() => loadVaultId(plugin.app));
  const getHomeDir = dependencies.getHomeDir ?? getDefaultHomeDir;
  const getLiveTarget = createLiveAgentTargetGetter(plugin, getVaultId);

  return {
    id: LOCAL_IMAGE_CHAT_STAGING_COMMAND_ID,
    name: LOCAL_IMAGE_CHAT_STAGING_COMMAND_NAME,
    icon: LOCAL_IMAGE_COMMAND_ICON,
    callback: async () => {
      if (!desktopCheck()) {
        new Notice("Local image preparation is only available on desktop.");
        return;
      }

      const activeNote = getActiveMarkdownNote(plugin.app);
      if (!activeNote) {
        new Notice("Open an active Markdown note before preparing local images.");
        return;
      }

      let runtime: LocalImageRuntime | undefined;
      const disposeOwnedRuntime = async (value: LocalImageRuntime): Promise<void> => {
        await disposeRuntime(value);
        dependencies.onRuntimeDisposed?.(value);
      };

      try {
        const capturedAgent = await readActiveAgentTarget(plugin, getVaultId);
        if (!capturedAgent) {
          new Notice("Open an existing Agent Chat session before preparing images for it.");
          return;
        }

        const noteText = await readBoundedNote(plugin.app, activeNote.file);
        if (!(await activeAgentTargetMatches(plugin, getVaultId, capturedAgent.target))) {
          new Notice("The Agent Chat target changed. Run the command again.");
          return;
        }

        const getLiveScope = createLiveScope(plugin.app, getVaultId);
        const initialScope = await getLiveScope();
        if (!matchesActiveNote(initialScope, activeNote)) {
          new Notice("The active note changed. Run the command again.");
          return;
        }
        if (
          initialScope.vaultId !== capturedAgent.target.vaultId ||
          !(await activeAgentTargetMatches(plugin, getVaultId, capturedAgent.target))
        ) {
          new Notice("The Agent Chat target changed. Run the command again.");
          return;
        }

        runtime = await createRuntime({
          app: plugin.app,
          vault: plugin.app.vault,
          vaultId: capturedAgent.target.vaultId,
          homeDir: getHomeDir(),
          getLiveScope,
          isDesktopRuntime: desktopCheck,
        });
        dependencies.onRuntimeCreated?.(runtime);
        if (!(await activeAgentTargetMatches(plugin, getVaultId, capturedAgent.target))) {
          await disposeOwnedRuntime(runtime);
          runtime = undefined;
          new Notice("The Agent Chat target changed. Run the command again.");
          return;
        }

        const preview = await runtime.preview({
          notePath: activeNote.notePath,
          scopePath: activeNote.scopePath,
          noteText,
        });
        if (!(await activeAgentTargetMatches(plugin, getVaultId, capturedAgent.target))) {
          await disposeOwnedRuntime(runtime);
          runtime = undefined;
          new Notice("The Agent Chat target changed. Run the command again.");
          return;
        }

        await showLocalImageChatStagingConfirmation(
          plugin,
          runtime,
          preview,
          initialScope,
          getLiveScope,
          capturedAgent,
          getLiveTarget,
          getVaultId,
          disposeOwnedRuntime,
          () => {
            runtime = undefined;
          }
        );
      } catch {
        if (runtime) {
          await disposeOwnedRuntime(runtime);
        }
        new Notice("Local image preparation failed. No model or network request was made.");
      }
    },
  };
}

/**
 * Register the desktop-only local-image command with Obsidian.
 *
 * The B runtime remains a lazy import so mobile and emulated-mobile plugin
 * loads never evaluate its desktop filesystem composition.
 * `registerCommands` is invoked by the plugin after its awaited settings
 * hydration. This registration boundary does not resolve the vault identity
 * or create a runtime; both happen only after the user explicitly invokes the
 * command, so the injected identity getter must observe that hydrated host
 * state and this layer never mutates keychain state.
 *
 * @param plugin - Plugin instance receiving the command.
 * @param dependencies - Optional seams for tests and host-specific injection.
 */
export function registerLocalImageCommands(
  plugin: CopilotPlugin,
  dependencies: LocalImageCommandDependencies = {}
): void {
  const desktopCheck = dependencies.isDesktopRuntime ?? isDesktopRuntime;
  if (!desktopCheck()) {
    return;
  }

  const activeRuntimes = new Set<LocalImageRuntime>();
  if (typeof plugin.register === "function") {
    plugin.register(() => {
      const runtimes = Array.from(activeRuntimes);
      activeRuntimes.clear();
      for (const runtime of runtimes) {
        void disposeRuntime(runtime);
      }
    });
  }

  const command = createLocalImagePreparationCommand(plugin, {
    ...dependencies,
    onRuntimeCreated: (runtime) => {
      activeRuntimes.add(runtime);
      dependencies.onRuntimeCreated?.(runtime);
    },
    onRuntimeDisposed: (runtime) => {
      activeRuntimes.delete(runtime);
      dependencies.onRuntimeDisposed?.(runtime);
    },
  });
  plugin.addCommand(command);

  const chatStagingCommand = createLocalImageChatStagingCommand(plugin, {
    ...dependencies,
    onRuntimeCreated: (runtime) => {
      activeRuntimes.add(runtime);
      dependencies.onRuntimeCreated?.(runtime);
    },
    onRuntimeDisposed: (runtime) => {
      activeRuntimes.delete(runtime);
      dependencies.onRuntimeDisposed?.(runtime);
    },
  });
  plugin.addCommand(chatStagingCommand);
}

async function showLocalImageConfirmation(
  plugin: CopilotPlugin,
  runtime: LocalImageRuntime,
  preview: LocalImagePreview,
  initialScope: LiveScope,
  getLiveScope: LocalImageRuntimeOptions["getLiveScope"],
  dispose: (runtime: LocalImageRuntime) => Promise<void>,
  clearRuntime: () => void
): Promise<void> {
  const previewId = readPreviewId(preview);
  if (!previewId) {
    await dispose(runtime);
    clearRuntime();
    new Notice("The local image preview was invalid. Run the command again.");
    return;
  }

  let settled = false;
  let actionStarted = false;
  const finish = async () => {
    if (settled) return;
    settled = true;
    await dispose(runtime);
    clearRuntime();
  };

  const modal = new ConfirmModal(
    plugin.app,
    async () => {
      if (actionStarted || settled) return;
      actionStarted = true;

      let currentScope: LiveScope;
      try {
        currentScope = await getLiveScope();
      } catch (error) {
        await finish();
        new Notice(formatRuntimeFailure(error));
        return;
      }
      if (!sameLiveScope(initialScope, currentScope)) {
        await finish();
        new Notice(formatLiveScopeChangedNotice(initialScope, currentScope));
        return;
      }

      let confirmation: LocalImageConfirmation;
      try {
        // This synchronous token issuance is intentionally inside the native
        // confirmation callback. Preview never grants permission to read bytes.
        confirmation = runtime.issueConfirmation(previewId);
        if (confirmation == null) {
          await finish();
          new Notice("The local image preview is no longer valid. Run the command again.");
          return;
        }
      } catch (error) {
        await finish();
        new Notice(formatRuntimeFailure(error, "preview"));
        return;
      }

      try {
        const request: LocalImageRuntimeExecutionRequest = { confirmation };
        const result: LocalImageRuntimeExecutionResult = await runtime.execute(request);
        await finish();
        new Notice(formatPreparationResult(result));
      } catch (error) {
        await finish();
        new Notice(formatRuntimeFailure(error));
      }
    },
    formatPreview(preview, initialScope),
    LOCAL_IMAGE_COMMAND_NAME,
    "Save images locally",
    "Cancel",
    () => finish()
  );

  modal.open();
}

function formatPreview(
  preview: LocalImagePreview,
  scope: LiveScope,
  finalQuestion = "Continue to read image bytes and save local copies?"
): string {
  const record = asRecord(preview);
  const notePath = boundedDisplayString(record?.notePath) ?? boundedDisplayString(scope.notePath);
  const scopePath =
    boundedDisplayString(record?.scopePath) ?? boundedDisplayString(scope.scopePath);
  const storageRoot = boundedDisplayString(record?.storageRoot) ?? "off-vault local storage";
  const candidateRefs = readCandidateReferences(record);
  const candidateCount = boundedCount(record?.candidateCount, candidateRefs.length);
  const rejectedCount = boundedCount(record?.rejectedCount, 0);
  const truncatedCount = boundedCount(
    record?.omittedCount ?? record?.truncatedCount,
    record?.truncated === true ? 1 : 0
  );

  const lines = [
    `Note: ${notePath ?? "active Markdown note"}`,
    `Allowed folder scope: ${formatScope(scopePath)}`,
    `Local-only storage: ${storageRoot}`,
    `Image candidates: ${candidateCount}`,
    `Rejected during preview: ${rejectedCount}`,
    truncatedCount > 0
      ? `The note exceeded the preview bound; ${truncatedCount} result${truncatedCount === 1 ? "" : "s"} may be truncated.`
      : "",
    candidateRefs.length > 0 ? `Candidates: ${candidateRefs.join(", ")}` : "",
    "No model or network request will be made.",
    finalQuestion,
  ];
  return lines.filter(Boolean).join("\n");
}

async function showLocalImageChatStagingConfirmation(
  plugin: CopilotPlugin,
  runtime: LocalImageRuntime,
  preview: LocalImagePreview,
  initialScope: LiveScope,
  getLiveScope: LocalImageRuntimeOptions["getLiveScope"],
  capturedAgent: ActiveAgentTargetSnapshot,
  getLiveTarget: SessionLocalAttachmentLiveTargetGetter,
  getVaultId: () => string | Promise<string>,
  dispose: (runtime: LocalImageRuntime) => Promise<void>,
  clearRuntime: () => void
): Promise<void> {
  const previewId = readPreviewId(preview);
  if (!previewId) {
    await dispose(runtime);
    clearRuntime();
    new Notice("The local image preview was invalid. Run the command again.");
    return;
  }

  let settled = false;
  let actionStarted = false;
  const finish = async () => {
    if (settled) return;
    settled = true;
    await dispose(runtime);
    clearRuntime();
  };

  const modal = new ConfirmModal(
    plugin.app,
    async () => {
      if (actionStarted || settled) return;
      actionStarted = true;

      let currentScope: LiveScope;
      try {
        currentScope = await getLiveScope();
      } catch {
        await finish();
        new Notice("Local image preparation failed. No model or network request was made.");
        return;
      }
      if (!sameLiveScope(initialScope, currentScope)) {
        await finish();
        new Notice(formatLiveScopeChangedNotice(initialScope, currentScope));
        return;
      }
      if (!(await activeAgentTargetMatches(plugin, getVaultId, capturedAgent.target))) {
        await finish();
        new Notice("The Agent Chat target changed. Run the command again.");
        return;
      }

      let confirmation: LocalImageConfirmation;
      try {
        // This synchronous token issuance is intentionally inside the native
        // confirmation callback. Preview never grants permission to read bytes.
        confirmation = runtime.issueConfirmation(previewId);
        if (confirmation == null) {
          await finish();
          new Notice("The local image preview is no longer valid. Run the command again.");
          return;
        }
      } catch (error) {
        await finish();
        new Notice(formatRuntimeFailure(error, "preview"));
        return;
      }

      try {
        const result: LocalImageRuntimeExecutionResult = await runtime.execute({ confirmation });
        const currentAgent = await readActiveAgentTarget(plugin, getVaultId);
        if (
          !currentAgent ||
          currentAgent.session !== capturedAgent.session ||
          !sameAgentTarget(currentAgent.target, capturedAgent.target)
        ) {
          await finish();
          new Notice(formatRetainedLocalResult(result));
          return;
        }

        const refs = extractStagingRefs(result, capturedAgent.target.vaultId);
        if (refs === null) {
          await finish();
          new Notice(formatUnstagedLocalResult(result));
          return;
        }
        if (refs.length === 0) {
          await finish();
          new Notice(formatChatStagingResult(result, 0));
          return;
        }

        const staging: SessionLocalAttachmentStaging =
          currentAgent.session.getLocalAttachmentStaging({
            vaultId: capturedAgent.target.vaultId,
            getLiveTarget,
          });
        const snapshot: SessionLocalAttachmentSnapshot = await staging.stage({
          target: capturedAgent.target,
          refs,
        });
        await finish();
        new Notice(formatChatStagingResult(result, snapshot.refs.length));
      } catch (error) {
        await finish();
        new Notice(formatStagingFailure(error));
      }
    },
    formatChatStagingPreview(preview, initialScope, capturedAgent),
    LOCAL_IMAGE_CHAT_STAGING_COMMAND_NAME,
    "Save and stage images",
    "Cancel",
    () => finish()
  );

  modal.open();
}

function formatChatStagingPreview(
  preview: LocalImagePreview,
  scope: LiveScope,
  target: ActiveAgentTargetSnapshot
): string {
  const destination = formatAgentDestination(target);
  const base = formatPreview(preview, scope, "");
  return [
    base,
    `Destination Agent chat: ${destination}`,
    "Images will be stored locally and staged only for this chat; they will not be sent to the model.",
    "Staging is not included automatically in the next send and does not mean the images are ready for vision analysis.",
    "Continue to read image bytes, save local copies, and stage inert references?",
  ]
    .filter(Boolean)
    .join("\n");
}

async function readActiveAgentTarget(
  plugin: CopilotPlugin,
  getVaultId: () => string | Promise<string>
): Promise<ActiveAgentTargetSnapshot | null> {
  const manager = plugin.agentSessionManager;
  if (!manager) return null;

  let session: AgentSession | null;
  let projectId: string;
  try {
    session = manager.getActiveSession();
    projectId = manager.getActiveProjectId();
    if (!session || session.getStatus() === "closed" || session.projectId !== projectId) {
      return null;
    }
  } catch {
    return null;
  }

  let vaultId: string;
  try {
    vaultId = await getVaultId();
  } catch {
    return null;
  }
  if (!isValidAttachmentVaultId(vaultId)) return null;

  try {
    const currentSession = manager.getActiveSession();
    const currentProjectId = manager.getActiveProjectId();
    if (
      currentSession !== session ||
      !currentSession ||
      currentSession.getStatus() === "closed" ||
      currentProjectId !== projectId ||
      currentSession.projectId !== currentProjectId
    ) {
      return null;
    }
    return {
      session: currentSession,
      target: {
        sessionId: currentSession.internalId,
        projectId: currentSession.projectId,
        vaultId,
      },
    };
  } catch {
    return null;
  }
}

function createLiveAgentTargetGetter(
  plugin: CopilotPlugin,
  getVaultId: () => string | Promise<string>
): SessionLocalAttachmentLiveTargetGetter {
  return async () => (await readActiveAgentTarget(plugin, getVaultId))?.target ?? null;
}

async function activeAgentTargetMatches(
  plugin: CopilotPlugin,
  getVaultId: () => string | Promise<string>,
  expected: SessionLocalAttachmentTarget
): Promise<boolean> {
  const current = await readActiveAgentTarget(plugin, getVaultId);
  return current !== null && sameAgentTarget(current.target, expected);
}

function sameAgentTarget(
  left: SessionLocalAttachmentTarget,
  right: SessionLocalAttachmentTarget
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.projectId === right.projectId &&
    left.vaultId === right.vaultId
  );
}

function formatAgentDestination(target: ActiveAgentTargetSnapshot): string {
  let label: string | null = null;
  try {
    label = target.session.getLabel();
  } catch {
    // Use the bounded identity fallback if a synthetic or closing session
    // cannot provide its optional display label.
  }
  const sessionName = boundedDisplayString(label) ?? "active Agent Chat session";
  const projectName =
    target.target.projectId === "__global__"
      ? "global project scope"
      : `project scope ${boundedDisplayString(target.target.projectId) ?? "current"}`;
  return `${sessionName}; ${projectName}`;
}

function extractStagingRefs(
  result: LocalImageRuntimeExecutionResult,
  vaultId: string
): readonly LocalAttachmentRef[] | null {
  const persisted = asRecord(result)?.persisted;
  if (!Array.isArray(persisted)) return null;
  if (persisted.length === 0) return EMPTY_LOCAL_ATTACHMENT_REFS;
  if (persisted.length > MAX_CHAT_ATTACHMENT_REFS) return null;

  const candidates: Array<Record<string, unknown>> = [];
  for (let index = 0; index < persisted.length; index += 1) {
    const attachment = asRecord(persisted[index]);
    const source = asRecord(attachment?.source);
    if (
      !attachment ||
      attachment.schemaVersion !== CHAT_ATTACHMENT_REF_SCHEMA_VERSION ||
      source?.kind !== "vault" ||
      source.vaultId !== vaultId ||
      typeof attachment.attachmentId !== "string"
    ) {
      return null;
    }
    candidates.push({
      schemaVersion: CHAT_ATTACHMENT_REF_SCHEMA_VERSION,
      vaultId,
      attachmentId: attachment.attachmentId,
    });
  }

  const refs = normalizeLocalAttachmentRefs(candidates);
  return refs.length === persisted.length ? refs : null;
}

function formatPreparationResult(result: LocalImageRuntimeExecutionResult): string {
  return [...formatPreparationDetails(result), "Nothing was sent to a model or network."].join(" ");
}

function formatPreparationDetails(result: LocalImageRuntimeExecutionResult): string[] {
  const record = asRecord(result);
  const persisted = boundedCount(
    record?.persistedCount,
    Array.isArray(record?.persisted) ? record.persisted.length : 0
  );
  const rejected = boundedCount(record?.rejectedCount, countItems(record?.items, "rejected"));
  const failed = boundedCount(record?.failedCount, countItems(record?.items, "failed"));
  const skipped = boundedCount(record?.skippedCount, countItems(record?.items, "skipped"));
  const truncatedCount = boundedCount(record?.truncatedCount, record?.truncated === true ? 1 : 0);
  const details = [`Saved ${persisted} local image${persisted === 1 ? "" : "s"}.`];
  if (rejected > 0) details.push(`Rejected ${rejected}.`);
  if (failed > 0) details.push(`Failed ${failed}.`);
  if (skipped > 0) details.push(`Skipped ${skipped}.`);
  if (truncatedCount > 0) {
    details.push(
      `The bounded input was truncated (${truncatedCount} item${truncatedCount === 1 ? "" : "s"}).`
    );
  }
  return details;
}

function formatChatStagingResult(
  result: LocalImageRuntimeExecutionResult,
  stagedCount: number
): string {
  const boundedStagedCount = boundedCount(stagedCount, 0);
  return [
    ...formatPreparationDetails(result),
    `Staged ${boundedStagedCount} local image reference${boundedStagedCount === 1 ? "" : "s"} for this Agent chat.`,
    "Nothing was sent to a model or network; staging is not included automatically in the next send.",
  ].join(" ");
}

function formatRetainedLocalResult(result: LocalImageRuntimeExecutionResult): string {
  return [
    ...formatPreparationDetails(result),
    "The Agent Chat target changed before staging. Local records were retained; nothing was staged.",
    "Nothing was sent to a model or network.",
  ].join(" ");
}

function formatUnstagedLocalResult(result: LocalImageRuntimeExecutionResult): string {
  return [
    ...formatPreparationDetails(result),
    "Local records were retained, but no inert references were staged.",
    "Nothing was sent to a model or network.",
  ].join(" ");
}

function formatStagingFailure(error: unknown): string {
  if (isSessionLocalAttachmentStagingError(error)) {
    if (
      error.code === "stale-target" ||
      error.code === "foreign-vault" ||
      error.code === "disposed"
    ) {
      return "Local images were saved, but the Agent Chat target changed before staging. Local records were retained; nothing was staged. Nothing was sent to a model or network.";
    }
  }
  return "Local images were saved, but staging failed. Local records were retained; nothing was staged. Nothing was sent to a model or network.";
}

function readCandidateReferences(record: Record<string, unknown> | null): string[] {
  const rawCandidates = Array.isArray(record?.candidateRefs)
    ? record.candidateRefs
    : Array.isArray(record?.candidates)
      ? record.candidates
      : [];
  const candidates: string[] = [];
  for (let index = 0; index < Math.min(rawCandidates.length, MAX_DISPLAY_CANDIDATES); index += 1) {
    const candidate = rawCandidates[index];
    const reference =
      typeof candidate === "string"
        ? boundedDisplayString(candidate)
        : boundedDisplayString(asRecord(candidate)?.reference);
    if (reference !== null) candidates.push(reference);
  }
  return candidates;
}

async function readBoundedNote(app: App, file: TFile): Promise<string> {
  if (file.stat.size > MAX_NOTE_TEXT_BYTES) {
    throw new Error("Active note exceeds the local image preview bound");
  }
  const text = await app.vault.read(file);
  if (new TextEncoder().encode(text).byteLength > MAX_NOTE_TEXT_BYTES) {
    throw new Error("Active note exceeds the local image preview bound");
  }
  return text;
}

function createLiveScope(
  app: App,
  getVaultId: () => string | Promise<string>
): LocalImageRuntimeOptions["getLiveScope"] {
  return async () => {
    const activeFile = getActiveMarkdownNote(app);
    return {
      vaultId: await getVaultId(),
      notePath: activeFile?.notePath ?? null,
      scopePath: activeFile?.scopePath ?? "",
    };
  };
}

function getActiveMarkdownNote(app: App): ActiveNoteSnapshot | null {
  const activeFile = app.workspace.getActiveFile();
  if (
    !activeFile ||
    typeof activeFile.extension !== "string" ||
    activeFile.extension.toLowerCase() !== "md" ||
    !activeFile.path
  ) {
    return null;
  }
  const parentPath = activeFile.parent?.path;
  if (parentPath !== undefined && typeof parentPath !== "string") return null;
  return {
    file: activeFile,
    notePath: activeFile.path,
    scopePath: parentPath ?? "",
  };
}

function matchesActiveNote(scope: LiveScope, activeNote: ActiveNoteSnapshot): boolean {
  return (
    scope.notePath === activeNote.notePath &&
    scope.scopePath === activeNote.scopePath &&
    typeof scope.vaultId === "string" &&
    scope.vaultId.length > 0
  );
}

function sameLiveScope(left: LiveScope, right: LiveScope): boolean {
  return (
    left.vaultId === right.vaultId &&
    left.notePath === right.notePath &&
    left.scopePath === right.scopePath
  );
}

function formatLiveScopeChangedNotice(initial: LiveScope, current: LiveScope): string {
  if (initial.vaultId !== current.vaultId) {
    return "The active vault changed. Run the command again.";
  }
  return "The active note or allowed folder changed. Run the command again.";
}

function readPreviewId(preview: LocalImagePreview): string | null {
  const value = asRecord(preview)?.previewId;
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
}

function boundedDisplayString(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.length <= MAX_DISPLAY_TEXT_LENGTH
    ? value
    : `${value.slice(0, MAX_DISPLAY_TEXT_LENGTH - 1)}…`;
}

function boundedCount(value: unknown, fallback: number): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    return Math.min(MAX_DISPLAY_COUNT, Math.max(0, fallback));
  }
  return Math.min(MAX_DISPLAY_COUNT, value as number);
}

function formatRuntimeFailure(error: unknown, phase?: "preview"): string {
  if (
    phase === "preview" &&
    isLocalImageRuntimeError(error) &&
    (error.code === "stale-preview" || error.code === "confirmation-replayed")
  ) {
    return "The local image preview is no longer valid. Run the command again.";
  }
  return "Local image preparation failed. No model or network request was made.";
}

function isLocalImageRuntimeError(value: unknown): value is LocalImageRuntimeError {
  const record = asRecord(value);
  return value instanceof Error && typeof record?.code === "string";
}

function isSessionLocalAttachmentStagingError(
  value: unknown
): value is SessionLocalAttachmentStagingError {
  const record = asRecord(value);
  return value instanceof Error && typeof record?.code === "string";
}

function countItems(value: unknown, status: string): number {
  if (!Array.isArray(value)) return 0;
  let count = 0;
  for (let index = 0; index < Math.min(value.length, MAX_DISPLAY_COUNT); index += 1) {
    if (asRecord(value[index])?.status === status) count += 1;
  }
  return count;
}

function formatScope(scopePath: string | null): string {
  return scopePath ? `${scopePath} (and descendants)` : "vault root (entire vault)";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function disposeRuntime(runtime: LocalImageRuntime): Promise<void> {
  try {
    await Promise.resolve(runtime.dispose());
  } catch {
    // Disposal is best effort after a failed or cancelled explicit action.
  }
}

async function loadLocalImageRuntime(
  options: LocalImageRuntimeOptions
): Promise<LocalImageRuntime> {
  const { createLocalImageRuntime } = await import("@/context/assets/localImageRuntime");
  return createLocalImageRuntime(options);
}

async function loadVaultId(app: App): Promise<string> {
  const { KeychainService } = await import("@/services/keychainService");
  return KeychainService.getInstance(app).getVaultId();
}

function getDefaultHomeDir(): string {
  return requireNodeModule<typeof import("node:os")>("os").homedir();
}
