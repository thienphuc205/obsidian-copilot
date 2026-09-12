import { FileSystemAdapter, TFile, type App, type TAbstractFile, type Vault } from "obsidian";

import { copilotAppDataDir } from "@/utils/appPaths";
import { isDesktopRuntime, requireNodeModule } from "@/utils/desktopRuntime";
import { sha256 } from "@/utils/hash";

import { parseEmbeddedAssetReferences, type LocalAssetReference } from "./assetReferenceParser";
import { MAX_LOCAL_IMAGE_BYTES, type LocalImageReader } from "./assetTypes";
import { AttachmentStore } from "./attachmentStore";
import { type AttachmentRestoreEnvelope } from "./authorizedAttachmentRestore";
import { createAuthorizedAttachmentRestore } from "./authorizedAttachmentRestore";
import {
  DEFAULT_LOCAL_IMAGE_INGESTION_MAX_BYTES,
  DEFAULT_LOCAL_IMAGE_INGESTION_MAX_COUNT,
  createLocalImageIngestion,
  type LocalImageIngestionResult,
} from "./localImageIngestion";
import { createNodeAttachmentIO } from "./nodeAttachmentIO";
import { createObsidianLocalImageReader } from "./obsidianLocalImageReader";
import { isValidAttachmentVaultId } from "./attachmentStoreTypes";

/** Maximum note text accepted by the explicit preview and reread boundary. */
export const LOCAL_IMAGE_RUNTIME_MAX_NOTE_TEXT = 256 * 1024;

/** Maximum explicit image destinations considered by one preview/execution. */
export const LOCAL_IMAGE_RUNTIME_MAX_INPUTS = 64;

const MAX_PATH_LENGTH = 4096;

/** The selected note and folder scope shown by the command before consent. */
export interface LocalImageRuntimeSelection {
  readonly notePath: string;
  readonly scopePath: string;
  /** Trusted command snapshot used only to render/bind the preview. */
  readonly noteText: string;
}

/** Authoritative host state queried by the runtime for every sensitive phase. */
export interface LocalImageRuntimeLiveScope {
  readonly vaultId: string;
  /** Null means that no Markdown note is currently active. */
  readonly notePath: string | null;
  readonly scopePath: string;
}

/** One bounded destination displayed in the explicit preview. */
export interface LocalImageRuntimePreviewCandidate {
  readonly reference: string;
  readonly syntax: LocalAssetReference["syntax"];
}

/** Parse-only preview. It contains no image bytes and is not a read capability. */
export interface LocalImageRuntimePreview {
  readonly previewId: string;
  readonly notePath: string;
  readonly scopePath: string;
  readonly candidates: readonly LocalImageRuntimePreviewCandidate[];
  readonly candidateCount: number;
  /** True when the bounded input/reference limit means work was omitted. */
  readonly truncated: boolean;
  /** A lower bound when the parser's own safety cap was also reached. */
  readonly omittedCount: number;
  readonly maxInputs: typeof LOCAL_IMAGE_RUNTIME_MAX_INPUTS;
  readonly maxPersistedReferences: typeof DEFAULT_LOCAL_IMAGE_INGESTION_MAX_COUNT;
  readonly maxImageBytes: number;
  /** Intended off-vault location; construction does not create it. */
  readonly storageRoot: string;
}

/** Opaque one-use token issued only after the command's explicit confirmation. */
export interface LocalImageRuntimeConfirmation {
  readonly previewId: string;
  readonly confirmationToken: string;
}

export interface LocalImageRuntimeExecutionRequest {
  readonly confirmation: LocalImageRuntimeConfirmation;
}

/** Result of the explicit local preparation operation. */
export interface LocalImageRuntimeExecutionResult extends LocalImageIngestionResult {
  readonly previewId: string;
}

export type LocalImageRuntimeErrorCode =
  | "invalid-options"
  | "invalid-selection"
  | "unsupported-host"
  | "identity-mismatch"
  | "scope-unavailable"
  | "canonical-binding-changed"
  | "note-unavailable"
  | "note-too-large"
  | "stale-preview"
  | "confirmation-required"
  | "confirmation-replayed"
  | "execution-in-progress"
  | "disposed"
  | "token-unavailable"
  | "storage-unavailable";

/** Sanitized failures from the runtime lifecycle boundary. */
export class LocalImageRuntimeError extends Error {
  constructor(
    readonly code: LocalImageRuntimeErrorCode,
    message: string
  ) {
    super(message);
    this.name = "LocalImageRuntimeError";
  }
}

export interface LocalImageRuntimeOptions {
  /** Explicit Obsidian application and vault; no global app is consulted. */
  readonly app: App;
  readonly vault: Vault;
  /** Stable host identity, not the legacy path-hash/default fallback. */
  readonly vaultId: string;
  /** Injected home directory used only to derive the off-vault namespace. */
  readonly homeDir: string;
  /** Authoritative current identity, active note, and allowed folder scope. */
  readonly getLiveScope: () => LocalImageRuntimeLiveScope | Promise<LocalImageRuntimeLiveScope>;
  /** Test seam; production uses the canonical desktop/mobile gate. */
  readonly isDesktopRuntime?: () => boolean;
}

export interface LocalImageRuntime {
  /** Parse the trusted active-note snapshot without reading an image or writing storage. */
  preview(selection: LocalImageRuntimeSelection): Promise<LocalImageRuntimePreview>;
  /** Issue a one-use token only after the caller has obtained explicit user consent. */
  issueConfirmation(previewId: string): LocalImageRuntimeConfirmation;
  /** Execute the previously previewed destinations against live host state. */
  execute(request: LocalImageRuntimeExecutionRequest): Promise<LocalImageRuntimeExecutionResult>;
  /** Restore one reference using the current live scope policy on every authorization check. */
  restore(envelope: AttachmentRestoreEnvelope): Promise<ArrayBuffer>;
  /** Invalidate pending consent and stop admitting further reads/writes. */
  dispose(): void;
}

interface NodeRuntimeModules {
  readonly fs: typeof import("node:fs");
  readonly path: typeof import("node:path");
}

interface RuntimeBinding {
  readonly vaultId: string;
  readonly canonicalVaultPath: string;
  readonly scopePath: string;
  readonly canonicalScopePath: string;
  readonly notePath: string;
  readonly canonicalNotePath: string;
}

interface LiveScopeBinding {
  readonly vaultId: string;
  readonly notePath: string | null;
  readonly scopePath: string;
  readonly canonicalVaultPath: string;
  readonly canonicalScopePath: string;
}

interface PendingPreview {
  readonly previewId: string;
  readonly binding: RuntimeBinding;
  readonly noteDigest: string;
  readonly inputs: readonly { reference: string; sourceNotePath: string }[];
  readonly publicPreview: LocalImageRuntimePreview;
  confirmationToken: string | null;
  consumed: boolean;
}

interface InFlightExecution {
  readonly confirmationToken: string;
  readonly promise: Promise<LocalImageRuntimeExecutionResult>;
}

/**
 * Compose the explicit desktop local-image path without wiring it to a
 * command. The factory resolves the vault binding and intended storage path,
 * but the attachment layout is created only by a later confirmed operation.
 *
 * The host identity and canonical vault path jointly define a bucket. A new
 * runtime created for a cloned vault identity/path therefore cannot silently
 * reuse this runtime's records. The canonical path is a binding check, not a
 * user-controlled authorization grant.
 */
export function createLocalImageRuntime(options: LocalImageRuntimeOptions): LocalImageRuntime {
  validateOptionsShape(options);
  const desktopCheck = options.isDesktopRuntime ?? isDesktopRuntime;
  if (!desktopCheck()) {
    throw new LocalImageRuntimeError(
      "unsupported-host",
      "Local image preparation requires the desktop runtime"
    );
  }

  const vaultId = validateStableVaultId(options.vaultId);
  if (options.app.vault !== options.vault) {
    throw new LocalImageRuntimeError(
      "unsupported-host",
      "Local image preparation requires the explicit app vault"
    );
  }

  const modules = loadNodeModules();
  const canonicalVaultPath = resolveCanonicalVaultPath(options.vault, modules);
  if (!modules.path.isAbsolute(options.homeDir)) {
    throw new LocalImageRuntimeError(
      "invalid-options",
      "Local image storage home directory must be absolute"
    );
  }
  const canonicalHomePath = resolveCanonicalDirectory(options.homeDir, modules);

  const bucketKey = sha256(`${vaultId}\u0000${canonicalVaultPath}`);
  const storageRoot = modules.path.join(
    copilotAppDataDir(canonicalHomePath),
    "attachments",
    "vaults",
    bucketKey
  );

  let disposed = false;
  let activePreview: PendingPreview | null = null;
  let inFlight: InFlightExecution | null = null;
  let store: AttachmentStore | null = null;

  const getCurrentLiveScope = async (): Promise<LiveScopeBinding> => {
    let rawScope: unknown;
    try {
      rawScope = await options.getLiveScope();
    } catch {
      throw new LocalImageRuntimeError(
        "scope-unavailable",
        "The current image scope could not be verified"
      );
    }

    if (!isRecord(rawScope)) {
      throw new LocalImageRuntimeError(
        "scope-unavailable",
        "The current image scope could not be verified"
      );
    }

    const liveVaultId = validateLiveVaultId(rawScope.vaultId);
    if (liveVaultId !== vaultId) {
      throw new LocalImageRuntimeError(
        "identity-mismatch",
        "The current vault identity does not match this runtime"
      );
    }

    const scopePath = normalizeVaultRelativePath(rawScope.scopePath, modules.path);
    if (scopePath === null) {
      throw new LocalImageRuntimeError(
        "scope-unavailable",
        "The current image scope could not be verified"
      );
    }
    const currentVaultPath = resolveCanonicalVaultPath(options.vault, modules);
    if (currentVaultPath !== canonicalVaultPath) {
      throw new LocalImageRuntimeError(
        "canonical-binding-changed",
        "The vault's canonical binding changed"
      );
    }

    let canonicalScopePath: string;
    try {
      canonicalScopePath = resolveCanonicalScopePath(currentVaultPath, scopePath, modules);
    } catch {
      throw new LocalImageRuntimeError(
        "scope-unavailable",
        "The current image scope could not be verified"
      );
    }

    let notePath: string | null = null;
    if (rawScope.notePath !== null) {
      notePath = normalizeMarkdownNotePath(rawScope.notePath, modules.path);
      if (notePath === null) {
        throw new LocalImageRuntimeError(
          "scope-unavailable",
          "The current active note could not be verified"
        );
      }
    }

    return {
      vaultId: liveVaultId,
      notePath,
      scopePath,
      canonicalVaultPath: currentVaultPath,
      canonicalScopePath,
    };
  };

  const getStore = (): AttachmentStore => {
    if (store === null) {
      store = new AttachmentStore(createNodeAttachmentIO(storageRoot));
    }
    return store;
  };

  const preview = async (
    selection: LocalImageRuntimeSelection
  ): Promise<LocalImageRuntimePreview> => {
    ensureNotDisposed();
    if (inFlight !== null) {
      throw new LocalImageRuntimeError(
        "execution-in-progress",
        "An image preparation operation is already running"
      );
    }
    const checkedSelection = validateSelection(selection, modules.path);
    const liveScope = await getCurrentLiveScope();
    ensureNotDisposed();
    const binding = createSelectionBinding(checkedSelection, liveScope, modules);
    if (!sameSelection(binding, liveScope)) {
      throw new LocalImageRuntimeError(
        "stale-preview",
        "The selected note or folder scope is no longer current"
      );
    }

    const references = parseEmbeddedAssetReferences(checkedSelection.noteText);
    const candidates = references.slice(0, LOCAL_IMAGE_RUNTIME_MAX_INPUTS).map(toPreviewCandidate);
    const truncated = references.length > LOCAL_IMAGE_RUNTIME_MAX_INPUTS;
    const omittedCount = truncated ? references.length - LOCAL_IMAGE_RUNTIME_MAX_INPUTS : 0;
    const previewId = createOpaqueToken("preview");
    const publicPreview: LocalImageRuntimePreview = {
      previewId,
      notePath: binding.notePath,
      scopePath: binding.scopePath,
      candidates,
      candidateCount: candidates.length,
      truncated,
      omittedCount,
      maxInputs: LOCAL_IMAGE_RUNTIME_MAX_INPUTS,
      maxPersistedReferences: DEFAULT_LOCAL_IMAGE_INGESTION_MAX_COUNT,
      maxImageBytes: MAX_LOCAL_IMAGE_BYTES,
      storageRoot,
    };

    activePreview = {
      previewId,
      binding,
      noteDigest: sha256(checkedSelection.noteText),
      inputs: candidates.map(({ reference }) => ({
        reference,
        sourceNotePath: binding.notePath,
      })),
      publicPreview,
      confirmationToken: null,
      consumed: false,
    };
    return publicPreview;
  };

  const issueConfirmation = (previewId: string): LocalImageRuntimeConfirmation => {
    ensureNotDisposed();
    const pending = activePreview;
    if (!pending || pending.previewId !== previewId) {
      throw new LocalImageRuntimeError(
        "confirmation-required",
        "The image preview is no longer current"
      );
    }
    if (pending.confirmationToken !== null || pending.consumed) {
      throw new LocalImageRuntimeError(
        "confirmation-replayed",
        "The image preview has already been confirmed"
      );
    }
    const confirmationToken = createOpaqueToken("confirm");
    pending.confirmationToken = confirmationToken;
    return { previewId, confirmationToken };
  };

  const execute = (
    request: LocalImageRuntimeExecutionRequest
  ): Promise<LocalImageRuntimeExecutionResult> => {
    if (disposed) return Promise.reject(runtimeError("disposed", "The image runtime is disposed"));
    if (!isRecord(request) || !isRecord(request.confirmation)) {
      return Promise.reject(
        runtimeError("confirmation-required", "Explicit image confirmation is required")
      );
    }
    const previewId = request.confirmation.previewId;
    const confirmationToken = request.confirmation.confirmationToken;
    if (typeof previewId !== "string" || typeof confirmationToken !== "string") {
      return Promise.reject(
        runtimeError("confirmation-required", "Explicit image confirmation is required")
      );
    }

    if (inFlight !== null) {
      if (inFlight.confirmationToken === confirmationToken) return inFlight.promise;
      return Promise.reject(
        runtimeError("execution-in-progress", "An image preparation operation is already running")
      );
    }

    const pending = activePreview;
    if (
      !pending ||
      pending.previewId !== previewId ||
      pending.confirmationToken !== confirmationToken ||
      pending.consumed
    ) {
      return Promise.reject(
        runtimeError("confirmation-required", "Explicit image confirmation is required")
      );
    }
    pending.consumed = true;
    const promise = runExecution(pending);
    inFlight = { confirmationToken, promise };
    void promise.then(
      () => clearInFlight(promise),
      () => clearInFlight(promise)
    );
    return promise;
  };

  const restore = async (envelope: AttachmentRestoreEnvelope): Promise<ArrayBuffer> => {
    ensureNotDisposed();
    await getCurrentLiveScope();
    const restoreService = createAuthorizedAttachmentRestore({
      store: getStore(),
      currentVaultId: vaultId,
      authorizeVaultPath: async (vaultPath) => {
        if (disposed) return false;
        try {
          const liveScope = await getCurrentLiveScope();
          const reader = createObsidianLocalImageReader({
            app: options.app,
            vault: options.vault,
            vaultId,
            scopePath: liveScope.scopePath,
          });
          const file = options.vault.getAbstractFileByPath(vaultPath);
          return file instanceof TFile && (await reader.authorizeResolvedFile(file));
        } catch {
          return false;
        }
      },
    });
    const bytes = await restoreService.restore(envelope);
    ensureNotDisposed();
    await getCurrentLiveScope();
    ensureNotDisposed();
    return bytes;
  };

  async function runExecution(pending: PendingPreview): Promise<LocalImageRuntimeExecutionResult> {
    ensureNotDisposed();
    const liveBeforeNote = await getCurrentLiveScope();
    ensureNotDisposed();
    assertPendingSelection(pending, liveBeforeNote, modules);
    const noteText = await readBoundedActiveNote(options.vault, liveBeforeNote.notePath);
    ensureNotDisposed();
    if (sha256(noteText) !== pending.noteDigest) {
      throw new LocalImageRuntimeError(
        "stale-preview",
        "The active note changed after the preview"
      );
    }

    const liveAfterNote = await getCurrentLiveScope();
    ensureNotDisposed();
    assertPendingSelection(pending, liveAfterNote, modules);

    const baseReader = createObsidianLocalImageReader({
      app: options.app,
      vault: options.vault,
      vaultId,
      scopePath: liveAfterNote.scopePath,
    });
    const guardedReader = createLiveReader(
      baseReader,
      options.app,
      options.vault,
      pending,
      getCurrentLiveScope,
      () => disposed
    );
    const guardedStore = {
      put: async (input: Parameters<AttachmentStore["put"]>[0]) => {
        if (disposed) throw new Error("Local image runtime disposed");
        const liveBeforeWrite = await getCurrentLiveScope();
        if (disposed) throw new Error("Local image runtime disposed");
        assertPendingSelection(pending, liveBeforeWrite, modules);
        return getStore().put(input);
      },
    };
    const ingestion = createLocalImageIngestion({
      reader: guardedReader,
      store: guardedStore,
      maxCount: DEFAULT_LOCAL_IMAGE_INGESTION_MAX_COUNT,
      maxBytes: DEFAULT_LOCAL_IMAGE_INGESTION_MAX_BYTES,
    });

    // This is the final live check before ingestion can authorize/read the
    // first image. The reader/store repeat the check for every later item.
    const liveBeforeImages = await getCurrentLiveScope();
    ensureNotDisposed();
    assertPendingSelection(pending, liveBeforeImages, modules);
    await ensureStorageRoot(canonicalHomePath, storageRoot, modules);
    ensureNotDisposed();
    const liveAfterStorage = await getCurrentLiveScope();
    assertPendingSelection(pending, liveAfterStorage, modules);
    const result = await ingestion.ingest(pending.inputs);
    return { ...result, previewId: pending.previewId };
  }

  function clearInFlight(promise: Promise<LocalImageRuntimeExecutionResult>): void {
    if (inFlight?.promise === promise) {
      inFlight = null;
      activePreview = null;
    }
  }

  function ensureNotDisposed(): void {
    if (disposed) throw runtimeError("disposed", "The image runtime is disposed");
  }

  return {
    preview,
    issueConfirmation,
    execute,
    restore,
    dispose() {
      disposed = true;
      activePreview = null;
    },
  };

  function runtimeError(code: LocalImageRuntimeErrorCode, message: string): LocalImageRuntimeError {
    return new LocalImageRuntimeError(code, message);
  }
}

function validateOptionsShape(value: unknown): asserts value is LocalImageRuntimeOptions {
  if (!isRecord(value)) {
    throw runtimeError("invalid-options", "Local image runtime options are invalid");
  }
  if (
    !isRecord(value.app) ||
    !isRecord(value.vault) ||
    typeof value.vaultId !== "string" ||
    typeof value.homeDir !== "string" ||
    typeof value.getLiveScope !== "function" ||
    (value.isDesktopRuntime !== undefined && typeof value.isDesktopRuntime !== "function")
  ) {
    throw runtimeError("invalid-options", "Local image runtime options are invalid");
  }
}

function validateStableVaultId(value: unknown): string {
  if (!isValidAttachmentVaultId(value) || value === "default") {
    throw runtimeError("invalid-options", "A stable host vault identity is required");
  }
  return value;
}

function validateLiveVaultId(value: unknown): string {
  if (!isValidAttachmentVaultId(value)) {
    throw runtimeError("identity-mismatch", "The current vault identity is invalid");
  }
  return value;
}

function validateSelection(
  value: unknown,
  nodePath: typeof import("node:path")
): LocalImageRuntimeSelection {
  if (
    !isRecord(value) ||
    typeof value.notePath !== "string" ||
    typeof value.scopePath !== "string"
  ) {
    throw runtimeError("invalid-selection", "The selected note and scope are invalid");
  }
  if (typeof value.noteText !== "string") {
    throw runtimeError("invalid-selection", "The selected note text is invalid");
  }
  const notePath = normalizeMarkdownNotePath(value.notePath, nodePath);
  const scopePath = normalizeVaultRelativePath(value.scopePath, nodePath);
  if (
    notePath === null ||
    scopePath === null ||
    value.noteText.length > LOCAL_IMAGE_RUNTIME_MAX_NOTE_TEXT
  ) {
    throw runtimeError(
      value.noteText.length > LOCAL_IMAGE_RUNTIME_MAX_NOTE_TEXT
        ? "note-too-large"
        : "invalid-selection",
      value.noteText.length > LOCAL_IMAGE_RUNTIME_MAX_NOTE_TEXT
        ? "The active note exceeds the preview limit"
        : "The selected note and scope are invalid"
    );
  }
  if (!isWithinScope(notePath, scopePath)) {
    throw runtimeError(
      "invalid-selection",
      "The selected note is outside the allowed folder scope"
    );
  }
  return { notePath, scopePath, noteText: value.noteText };
}

function createSelectionBinding(
  selection: LocalImageRuntimeSelection,
  liveScope: LiveScopeBinding,
  modules: NodeRuntimeModules
): RuntimeBinding {
  if (liveScope.notePath !== selection.notePath || liveScope.scopePath !== selection.scopePath) {
    throw runtimeError("stale-preview", "The selected note or folder scope is no longer current");
  }
  let canonicalNotePath: string;
  try {
    canonicalNotePath = resolveCanonicalNotePath(
      liveScope.canonicalVaultPath,
      selection.notePath,
      liveScope.canonicalScopePath,
      modules
    );
  } catch {
    throw runtimeError("note-unavailable", "The selected note could not be verified");
  }
  return {
    vaultId: liveScope.vaultId,
    canonicalVaultPath: liveScope.canonicalVaultPath,
    scopePath: selection.scopePath,
    canonicalScopePath: liveScope.canonicalScopePath,
    notePath: selection.notePath,
    canonicalNotePath,
  };
}

function assertPendingSelection(
  pending: PendingPreview,
  liveScope: LiveScopeBinding,
  modules: NodeRuntimeModules
): void {
  if (!sameSelection(pending.binding, liveScope) || liveScope.notePath === null) {
    throw runtimeError(
      "stale-preview",
      "The active note or folder scope changed after the preview"
    );
  }
  let canonicalNotePath: string;
  try {
    canonicalNotePath = resolveCanonicalNotePath(
      liveScope.canonicalVaultPath,
      liveScope.notePath,
      liveScope.canonicalScopePath,
      modules
    );
  } catch {
    throw runtimeError("stale-preview", "The active note could not be verified");
  }
  if (canonicalNotePath !== pending.binding.canonicalNotePath) {
    throw runtimeError(
      "stale-preview",
      "The active note's canonical binding changed after the preview"
    );
  }
}

function sameSelection(binding: RuntimeBinding, liveScope: LiveScopeBinding): boolean {
  return (
    binding.vaultId === liveScope.vaultId &&
    binding.canonicalVaultPath === liveScope.canonicalVaultPath &&
    binding.scopePath === liveScope.scopePath &&
    binding.canonicalScopePath === liveScope.canonicalScopePath &&
    binding.notePath === liveScope.notePath
  );
}

function createLiveReader(
  baseReader: LocalImageReader,
  app: App,
  vault: Vault,
  pending: PendingPreview,
  getCurrentLiveScope: () => Promise<LiveScopeBinding>,
  isDisposed: () => boolean
): LocalImageReader {
  const authorizeAgainstLiveScope = async (
    file: Parameters<LocalImageReader["authorizeResolvedFile"]>[0]
  ): Promise<boolean> => {
    if (isDisposed()) return false;
    try {
      const liveScope = await getCurrentLiveScope();
      if (!sameSelection(pending.binding, liveScope) || liveScope.notePath === null) return false;
      const reader = createObsidianLocalImageReader({
        app,
        vault,
        vaultId: pending.binding.vaultId,
        scopePath: liveScope.scopePath,
      });
      return reader.authorizeResolvedFile(file);
    } catch {
      return false;
    }
  };

  return {
    resolveLink: (reference, sourceNotePath) => baseReader.resolveLink(reference, sourceNotePath),
    getVaultId: () => baseReader.getVaultId(),
    authorizeResolvedFile: authorizeAgainstLiveScope,
    async readBinary(file) {
      if (!(await authorizeAgainstLiveScope(file))) {
        throw new Error("Local image read denied");
      }
      const liveScope = await getCurrentLiveScope();
      if (!sameSelection(pending.binding, liveScope)) {
        throw new Error("Local image read denied");
      }
      const reader = createObsidianLocalImageReader({
        app,
        vault,
        vaultId: pending.binding.vaultId,
        scopePath: liveScope.scopePath,
      });
      return reader.readBinary(file);
    },
  };
}

async function readBoundedActiveNote(vault: Vault, notePath: string | null): Promise<string> {
  if (notePath === null) {
    throw runtimeError("note-unavailable", "No active Markdown note is selected");
  }
  let abstractFile: TAbstractFile | null;
  try {
    abstractFile = vault.getAbstractFileByPath(notePath);
  } catch {
    throw runtimeError("note-unavailable", "The active note could not be read");
  }
  if (!(abstractFile instanceof TFile)) {
    throw runtimeError("note-unavailable", "The active note could not be read");
  }
  if (
    !abstractFile.stat ||
    !Number.isFinite(abstractFile.stat.size) ||
    abstractFile.stat.size < 0 ||
    abstractFile.stat.size > LOCAL_IMAGE_RUNTIME_MAX_NOTE_TEXT
  ) {
    throw runtimeError("note-too-large", "The active note exceeds the preview limit");
  }
  let noteText: string;
  try {
    noteText = await vault.read(abstractFile);
  } catch {
    throw runtimeError("note-unavailable", "The active note could not be read");
  }
  if (noteText.length > LOCAL_IMAGE_RUNTIME_MAX_NOTE_TEXT) {
    throw runtimeError("note-too-large", "The active note exceeds the preview limit");
  }
  return noteText;
}

function toPreviewCandidate(reference: LocalAssetReference): LocalImageRuntimePreviewCandidate {
  return { reference: reference.reference, syntax: reference.syntax };
}

function loadNodeModules(): NodeRuntimeModules {
  return {
    fs: requireNodeModule<typeof import("node:fs")>("fs"),
    path: requireNodeModule<typeof import("node:path")>("path"),
  };
}

function resolveCanonicalDirectory(homeDir: string, modules: NodeRuntimeModules): string {
  try {
    if (!modules.fs.statSync(homeDir).isDirectory()) throw new Error("not a directory");
    return modules.path.resolve(modules.fs.realpathSync(homeDir));
  } catch {
    throw runtimeError("invalid-options", "The local image storage home is unavailable");
  }
}

/** Create only the selected bucket after confirmation, rejecting symlinked components. */
async function ensureStorageRoot(
  canonicalHomePath: string,
  storageRoot: string,
  modules: NodeRuntimeModules
): Promise<void> {
  const target = modules.path.resolve(storageRoot);
  if (!isContained(modules.path, canonicalHomePath, target, false)) {
    throw runtimeError("storage-unavailable", "Local image storage is unavailable");
  }

  let current = canonicalHomePath;
  const relative = modules.path.relative(canonicalHomePath, target);
  for (const segment of relative.split(modules.path.sep)) {
    if (!segment) continue;
    current = modules.path.join(current, segment);
    let stats;
    try {
      stats = await modules.fs.promises.lstat(current);
    } catch (error) {
      if (!isNotFound(error)) {
        throw runtimeError("storage-unavailable", "Local image storage is unavailable");
      }
      try {
        await modules.fs.promises.mkdir(current);
      } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) {
          throw runtimeError("storage-unavailable", "Local image storage is unavailable");
        }
      }
      try {
        stats = await modules.fs.promises.lstat(current);
      } catch {
        throw runtimeError("storage-unavailable", "Local image storage is unavailable");
      }
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw runtimeError("storage-unavailable", "Local image storage is unavailable");
    }
    try {
      const physicalPath = modules.path.resolve(await modules.fs.promises.realpath(current));
      if (!isContained(modules.path, canonicalHomePath, physicalPath, false)) {
        throw runtimeError("storage-unavailable", "Local image storage is unavailable");
      }
    } catch (error) {
      if (error instanceof LocalImageRuntimeError) throw error;
      throw runtimeError("storage-unavailable", "Local image storage is unavailable");
    }
  }
}

function resolveCanonicalVaultPath(vault: Vault, modules: NodeRuntimeModules): string {
  const adapter = vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) {
    throw runtimeError("unsupported-host", "The vault has no desktop filesystem adapter");
  }
  let basePath: string;
  try {
    basePath = adapter.getBasePath();
  } catch {
    throw runtimeError("unsupported-host", "The vault filesystem binding is unavailable");
  }
  if (typeof basePath !== "string" || !modules.path.isAbsolute(basePath)) {
    throw runtimeError("unsupported-host", "The vault filesystem binding is unavailable");
  }
  try {
    if (!modules.fs.statSync(basePath).isDirectory()) {
      throw new Error("not a directory");
    }
    return modules.path.resolve(modules.fs.realpathSync(basePath));
  } catch {
    throw runtimeError("unsupported-host", "The vault filesystem binding is unavailable");
  }
}

function resolveCanonicalScopePath(
  canonicalVaultPath: string,
  scopePath: string,
  modules: NodeRuntimeModules
): string {
  const lexicalPath = modules.path.resolve(canonicalVaultPath, scopePath || ".");
  if (!isContained(modules.path, canonicalVaultPath, lexicalPath, true)) {
    throw new Error("scope escapes vault");
  }
  const canonicalPath = modules.path.resolve(modules.fs.realpathSync(lexicalPath));
  if (
    !isContained(modules.path, canonicalVaultPath, canonicalPath, true) ||
    !modules.fs.statSync(canonicalPath).isDirectory()
  ) {
    throw new Error("scope is not a directory");
  }
  return canonicalPath;
}

function resolveCanonicalNotePath(
  canonicalVaultPath: string,
  notePath: string,
  canonicalScopePath: string,
  modules: NodeRuntimeModules
): string {
  const lexicalPath = modules.path.resolve(canonicalVaultPath, notePath);
  if (!isContained(modules.path, canonicalVaultPath, lexicalPath, false)) {
    throw new Error("note escapes vault");
  }
  const canonicalPath = modules.path.resolve(modules.fs.realpathSync(lexicalPath));
  if (
    !isContained(modules.path, canonicalVaultPath, canonicalPath, false) ||
    !isContained(modules.path, canonicalScopePath, canonicalPath, false) ||
    !modules.fs.statSync(canonicalPath).isFile()
  ) {
    throw new Error("note is outside scope");
  }
  return canonicalPath;
}

function normalizeMarkdownNotePath(
  value: unknown,
  nodePath: typeof import("node:path")
): string | null {
  if (typeof value !== "string" || !value.toLowerCase().endsWith(".md")) return null;
  return normalizeVaultRelativePath(value, nodePath);
}

function normalizeVaultRelativePath(
  value: unknown,
  nodePath: typeof import("node:path")
): string | null {
  if (
    typeof value !== "string" ||
    value.length > MAX_PATH_LENGTH ||
    nodePath.isAbsolute(value) ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith("\\\\") ||
    hasControlCharacter(value)
  ) {
    return null;
  }
  const stack: string[] = [];
  for (const segment of value.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join("/");
}

function isWithinScope(notePath: string, scopePath: string): boolean {
  return scopePath === "" || notePath.startsWith(`${scopePath}/`);
}

function isContained(
  nodePath: typeof import("node:path"),
  root: string,
  target: string,
  allowEqual: boolean
): boolean {
  const relative = nodePath.relative(root, target);
  if (relative === "") return allowEqual;
  return (
    relative !== ".." && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative)
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

function createOpaqueToken(label: string): string {
  const crypto = window.crypto;
  if (typeof crypto?.randomUUID === "function") {
    return `${label}-${crypto.randomUUID()}`;
  }
  if (typeof crypto?.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return `${label}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  throw runtimeError("token-unavailable", "A secure confirmation token is unavailable");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimeError(code: LocalImageRuntimeErrorCode, message: string): LocalImageRuntimeError {
  return new LocalImageRuntimeError(code, message);
}
