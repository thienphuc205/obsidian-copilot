import { requireNodeModule } from "@/utils/desktopRuntime";
import {
  ATTACHMENT_MAX_BYTES,
  AttachmentStoreError,
  type BinaryAttachmentIO,
} from "./attachmentStoreTypes";

const NODE_ATTACHMENT_NAMESPACE = "attachments-v1";
const BLOBS_DIRECTORY = "blobs";
const RECORDS_DIRECTORY = "records";
const TEMPORARY_FILE_PREFIX = ".attachment-tmp-";
const DEFAULT_RECORD_MAX_BYTES = 64 * 1024;
const MAX_RECORD_MAX_BYTES = 1024 * 1024;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_TEMP_NAME_ATTEMPTS = 32;

let temporaryFileSequence = 0;

/** Options for the desktop-only adapter's bounded file reads. */
export interface NodeAttachmentIOOptions {
  /** Maximum blob size accepted by this adapter. */
  readonly maxBlobBytes?: number;
  /** Maximum serialized reference size accepted by this adapter. */
  readonly maxRecordBytes?: number;
}

export type NodeAttachmentIOErrorCode =
  | "invalid-root"
  | "invalid-key"
  | "root-confinement"
  | "size-limit"
  | "corrupt-record"
  | "io";

interface SanitizedErrorCause {
  readonly name?: string;
  readonly code?: string;
}

/** Typed failures from the injected-root disk adapter. */
export class NodeAttachmentIOError extends Error {
  readonly cause?: SanitizedErrorCause;

  constructor(
    readonly code: NodeAttachmentIOErrorCode,
    message: string,
    cause?: unknown
  ) {
    super(message);
    this.name = "NodeAttachmentIOError";
    const sanitizedCause = summarizeErrorCause(cause);
    if (sanitizedCause) this.cause = sanitizedCause;
  }
}

/**
 * Creates a versioned, root-confined attachment adapter for desktop use.
 * Node built-ins are loaded only when this factory is called, keeping the
 * module graph safe for mobile callers that never construct the adapter.
 *
 * @param approvedRoot Existing absolute directory approved by the caller for
 * device-local attachment data.
 * @param options Bounded blob and record sizes for this adapter instance.
 * @returns The injected filesystem implementation consumed by AttachmentStore.
 */
export function createNodeAttachmentIO(
  approvedRoot: string,
  options: NodeAttachmentIOOptions = {}
): BinaryAttachmentIO {
  const fs = requireNodeModule<typeof import("node:fs")>("fs");
  const nodePath = requireNodeModule<typeof import("node:path")>("path");

  if (typeof approvedRoot !== "string" || !nodePath.isAbsolute(approvedRoot)) {
    throw new NodeAttachmentIOError(
      "invalid-root",
      "Attachment storage root must be an absolute path"
    );
  }

  const rootPath = nodePath.resolve(approvedRoot);
  const maxBlobBytes = validateLimit(
    options.maxBlobBytes,
    ATTACHMENT_MAX_BYTES,
    ATTACHMENT_MAX_BYTES,
    "blob"
  );
  const maxRecordBytes = validateLimit(
    options.maxRecordBytes,
    DEFAULT_RECORD_MAX_BYTES,
    MAX_RECORD_MAX_BYTES,
    "record"
  );

  return {
    async blobExists(contentDigest) {
      validateDigest(contentDigest);
      const layout = await loadLayout(false);
      if (!layout) return false;
      const target = nodePath.join(layout.blobsDirectory, contentDigest);
      return (await inspectFile(fs, nodePath, layout.root, target)) === "file";
    },

    async readBlob(contentDigest) {
      validateDigest(contentDigest);
      const layout = await loadLayout(false);
      if (!layout) return null;
      const target = nodePath.join(layout.blobsDirectory, contentDigest);
      return readBoundedFile(fs, nodePath, layout.root, target, maxBlobBytes, "attachment blob");
    },

    async writeBlobAtomic(contentDigest, bytes) {
      validateDigest(contentDigest);
      if (!(bytes instanceof ArrayBuffer)) {
        throw new NodeAttachmentIOError("io", "Attachment blob must be an ArrayBuffer");
      }
      if (bytes.byteLength > maxBlobBytes) {
        throw new NodeAttachmentIOError("size-limit", "Attachment blob exceeds its byte limit");
      }

      const layout = await loadLayout(true);
      const target = nodePath.join(layout.blobsDirectory, contentDigest);
      const state = await inspectFile(fs, nodePath, layout.root, target);
      if (state === "file") return;
      await installFileAtomically(
        fs,
        nodePath,
        layout.root,
        target,
        new Uint8Array(bytes),
        "attachment blob"
      );
    },

    async readRecord(attachmentId) {
      validateReferenceId(attachmentId);
      const layout = await loadLayout(false);
      if (!layout) return null;
      const target = nodePath.join(layout.recordsDirectory, `${attachmentId}.json`);
      const bytes = await readBoundedFile(
        fs,
        nodePath,
        layout.root,
        target,
        maxRecordBytes,
        "attachment record"
      );
      if (bytes === null) return null;

      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      } catch (error) {
        throw new NodeAttachmentIOError(
          "corrupt-record",
          "Attachment record is not valid JSON",
          error
        );
      }
    },

    async writeRecordAtomic(attachmentId, record) {
      validateReferenceId(attachmentId);
      if (!isRecord(record) || record.attachmentId !== attachmentId) {
        throw new NodeAttachmentIOError(
          "invalid-key",
          "Attachment record id does not match its storage key"
        );
      }

      let serialized: string;
      try {
        serialized = JSON.stringify(record);
      } catch (error) {
        throw new NodeAttachmentIOError("io", "Attachment record could not be serialized", error);
      }
      const bytes = new TextEncoder().encode(serialized);
      if (bytes.byteLength > maxRecordBytes) {
        throw new NodeAttachmentIOError("size-limit", "Attachment record exceeds its byte limit");
      }

      const layout = await loadLayout(true);
      const target = nodePath.join(layout.recordsDirectory, `${attachmentId}.json`);
      const state = await inspectFile(fs, nodePath, layout.root, target);
      if (state === "file") {
        throw new AttachmentStoreError(
          "reference-id-collision",
          "Attachment reference id already exists"
        );
      }
      const installed = await installFileAtomically(
        fs,
        nodePath,
        layout.root,
        target,
        bytes,
        "attachment record"
      );
      if (!installed) {
        throw new AttachmentStoreError(
          "reference-id-collision",
          "Attachment reference id already exists"
        );
      }
    },

    async removeRecord(attachmentId) {
      validateReferenceId(attachmentId);
      const layout = await loadLayout(false);
      if (!layout) return;
      const target = nodePath.join(layout.recordsDirectory, `${attachmentId}.json`);
      if ((await inspectFile(fs, nodePath, layout.root, target)) === "missing") return;
      try {
        await fs.promises.unlink(target);
      } catch (error) {
        if (isNotFound(error)) return;
        throw asIOError("Attachment record removal failed", error);
      }
    },
  };

  async function loadLayout(create: true): Promise<AttachmentLayout>;
  async function loadLayout(create: false): Promise<AttachmentLayout | null>;
  async function loadLayout(create: boolean): Promise<AttachmentLayout | null> {
    const root = await getRootRealPath(fs, nodePath, rootPath);
    const namespaceDirectory = nodePath.join(root, NODE_ATTACHMENT_NAMESPACE);
    const blobsDirectory = nodePath.join(namespaceDirectory, BLOBS_DIRECTORY);
    const recordsDirectory = nodePath.join(namespaceDirectory, RECORDS_DIRECTORY);

    if (create) {
      await ensureDirectoryChain(fs, nodePath, root, namespaceDirectory, true);
      await ensureDirectoryChain(fs, nodePath, root, blobsDirectory, true);
      await ensureDirectoryChain(fs, nodePath, root, recordsDirectory, true);
    } else {
      if (!(await ensureDirectoryChain(fs, nodePath, root, namespaceDirectory, false))) return null;
    }

    return { root, namespaceDirectory, blobsDirectory, recordsDirectory };
  }
}

interface AttachmentLayout {
  readonly root: string;
  readonly namespaceDirectory: string;
  readonly blobsDirectory: string;
  readonly recordsDirectory: string;
}

type NodeFs = typeof import("node:fs");
type NodePath = typeof import("node:path");

async function getRootRealPath(fs: NodeFs, nodePath: NodePath, rootPath: string): Promise<string> {
  let stats;
  try {
    stats = await fs.promises.lstat(rootPath);
  } catch (error) {
    throw new NodeAttachmentIOError(
      "invalid-root",
      "Attachment storage root is unavailable",
      error
    );
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new NodeAttachmentIOError(
      "invalid-root",
      "Attachment storage root must be a non-symbolic directory"
    );
  }

  try {
    return nodePath.resolve(await fs.promises.realpath(rootPath));
  } catch (error) {
    throw asIOError("Attachment storage root could not be resolved", error);
  }
}

async function ensureDirectoryChain(
  fs: NodeFs,
  nodePath: NodePath,
  root: string,
  target: string,
  create: boolean
): Promise<boolean> {
  const targetPath = nodePath.resolve(target);
  assertInside(nodePath, root, targetPath);
  const relative = nodePath.relative(root, targetPath);
  if (relative === "") return true;

  let current = root;
  for (const segment of relative.split(nodePath.sep)) {
    if (!segment) continue;
    current = nodePath.join(current, segment);
    let stats;
    try {
      stats = await fs.promises.lstat(current);
    } catch (error) {
      if (!isNotFound(error)) throw asIOError("Attachment directory check failed", error);
      if (!create) return false;
      try {
        await fs.promises.mkdir(current);
      } catch (mkdirError) {
        if (!isAlreadyExists(mkdirError)) {
          throw asIOError("Attachment directory creation failed", mkdirError);
        }
      }
      try {
        stats = await fs.promises.lstat(current);
      } catch (lstatError) {
        throw asIOError("Attachment directory check failed", lstatError);
      }
    }

    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new NodeAttachmentIOError(
        "root-confinement",
        "Attachment storage contains a non-directory path component"
      );
    }
    let physicalPath: string;
    try {
      physicalPath = nodePath.resolve(await fs.promises.realpath(current));
    } catch (error) {
      throw asIOError("Attachment directory could not be resolved", error);
    }
    assertInside(nodePath, root, physicalPath);
  }
  return true;
}

type FileState = "missing" | "file";

async function inspectFile(
  fs: NodeFs,
  nodePath: NodePath,
  root: string,
  target: string
): Promise<FileState> {
  const targetPath = nodePath.resolve(target);
  assertInside(nodePath, root, targetPath);
  if (!(await ensureDirectoryChain(fs, nodePath, root, nodePath.dirname(targetPath), false))) {
    return "missing";
  }

  let stats;
  try {
    stats = await fs.promises.lstat(targetPath);
  } catch (error) {
    if (isNotFound(error)) return "missing";
    throw asIOError("Attachment file check failed", error);
  }
  if (stats.isSymbolicLink()) {
    throw new NodeAttachmentIOError(
      "root-confinement",
      "Symbolic-link attachment files are not allowed"
    );
  }
  if (!stats.isFile()) {
    throw new NodeAttachmentIOError("root-confinement", "Attachment target is not a regular file");
  }

  let physicalPath: string;
  try {
    physicalPath = nodePath.resolve(await fs.promises.realpath(targetPath));
  } catch (error) {
    throw asIOError("Attachment file could not be resolved", error);
  }
  assertInside(nodePath, root, physicalPath);
  return "file";
}

async function readBoundedFile(
  fs: NodeFs,
  nodePath: NodePath,
  root: string,
  target: string,
  maxBytes: number,
  label: string
): Promise<ArrayBuffer | null> {
  if ((await inspectFile(fs, nodePath, root, target)) === "missing") return null;

  let handle;
  try {
    const readFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    handle = await fs.promises.open(target, readFlags);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw asIOError(`${label} open failed`, error);
  }

  try {
    const initialStats = await handle.stat();
    if (!initialStats.isFile()) {
      throw new NodeAttachmentIOError("root-confinement", `${label} is not a regular file`);
    }
    if (initialStats.size > maxBytes) {
      throw new NodeAttachmentIOError("size-limit", `${label} exceeds its byte limit`);
    }

    const bytes = new Uint8Array(initialStats.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) {
        throw new NodeAttachmentIOError("io", `${label} ended before its declared size`);
      }
      offset += result.bytesRead;
    }

    const finalStats = await handle.stat();
    if (finalStats.size !== initialStats.size || finalStats.size > maxBytes) {
      throw new NodeAttachmentIOError("io", `${label} changed while it was being read`);
    }
    return bytes.slice().buffer;
  } catch (error) {
    if (error instanceof NodeAttachmentIOError) throw error;
    throw asIOError(`${label} read failed`, error);
  } finally {
    try {
      await handle.close();
    } catch {
      // Preserve the read result or primary read error; the handle is already
      // unreachable and the next operation will re-open it.
    }
  }
}

async function installFileAtomically(
  fs: NodeFs,
  nodePath: NodePath,
  root: string,
  target: string,
  bytes: Uint8Array,
  label: string
): Promise<boolean> {
  const targetPath = nodePath.resolve(target);
  assertInside(nodePath, root, targetPath);
  const parent = nodePath.dirname(targetPath);
  if (!(await ensureDirectoryChain(fs, nodePath, root, parent, true))) {
    throw new NodeAttachmentIOError("root-confinement", `${label} parent is unavailable`);
  }
  if ((await inspectFile(fs, nodePath, root, targetPath)) === "file") return false;

  const { handle, temporaryPath } = await openTemporaryFile(fs, nodePath, parent, targetPath);
  let operationError: unknown;
  let installed = false;
  try {
    let writeError: unknown;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      writeError = error;
    }
    let closeError: unknown;
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
    if (writeError !== undefined) throw asThrownError(writeError, `${label} write failed`);
    if (closeError !== undefined) {
      throw asIOError(`${label} temporary-file close failed`, closeError);
    }

    try {
      await fs.promises.link(temporaryPath, targetPath);
      installed = true;
    } catch (error) {
      if (isAlreadyExists(error)) {
        // Re-check so a path that became a symlink is rejected rather than
        // being mistaken for an ordinary concurrent writer.
        await inspectFile(fs, nodePath, root, targetPath);
      } else {
        throw asIOError(`${label} atomic install failed`, error);
      }
    }
  } catch (error) {
    operationError = error;
  }

  let cleanupError: unknown;
  try {
    await fs.promises.unlink(temporaryPath);
  } catch (error) {
    cleanupError = error;
  }

  if (operationError !== undefined) {
    throw asThrownError(operationError, `${label} atomic install failed`);
  }
  if (cleanupError !== undefined && !isNotFound(cleanupError)) {
    throw asIOError(`${label} temporary-file cleanup failed`, cleanupError);
  }
  return installed;
}

async function openTemporaryFile(
  fs: NodeFs,
  nodePath: NodePath,
  parent: string,
  target: string
): Promise<{ handle: Awaited<ReturnType<NodeFs["promises"]["open"]>>; temporaryPath: string }> {
  for (let attempt = 0; attempt < MAX_TEMP_NAME_ATTEMPTS; attempt += 1) {
    const temporaryPath = nodePath.join(
      parent,
      `${TEMPORARY_FILE_PREFIX}${nodePath.basename(target)}-${Date.now().toString(36)}-${(temporaryFileSequence++).toString(36)}-${attempt.toString(36)}`
    );
    try {
      const handle = await fs.promises.open(temporaryPath, "wx", 0o600);
      return { handle, temporaryPath };
    } catch (error) {
      if (isAlreadyExists(error)) continue;
      throw asIOError("Attachment temporary-file creation failed", error);
    }
  }
  throw new NodeAttachmentIOError("io", "Attachment temporary-file name allocation is exhausted");
}

function validateDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new NodeAttachmentIOError("invalid-key", "Attachment content digest is invalid");
  }
}

function validateReferenceId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !REFERENCE_ID_PATTERN.test(value)) {
    throw new NodeAttachmentIOError("invalid-key", "Attachment reference id is invalid");
  }
}

function validateLimit(
  value: number | undefined,
  defaultValue: number,
  maximum: number,
  label: string
): number {
  const limit = value ?? defaultValue;
  if (!Number.isInteger(limit) || limit <= 0 || limit > maximum) {
    throw new NodeAttachmentIOError("size-limit", `Attachment ${label} limit is invalid`);
  }
  return limit;
}

function assertInside(nodePath: NodePath, root: string, target: string): void {
  const relative = nodePath.relative(root, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${nodePath.sep}`) ||
    nodePath.isAbsolute(relative)
  ) {
    throw new NodeAttachmentIOError(
      "root-confinement",
      "Attachment path escapes its approved root"
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return getErrorCode(error) === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return getErrorCode(error) === "EEXIST";
}

function getErrorCode(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.code !== "string") return undefined;
  return error.code;
}

function summarizeErrorCause(error: unknown): SanitizedErrorCause | undefined {
  if (!isRecord(error)) return undefined;

  const summary: { name?: string; code?: string } = {};
  if (typeof error.name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)) {
    summary.name = error.name;
  }
  if (typeof error.code === "string" && /^[A-Za-z0-9_.-]{1,32}$/.test(error.code)) {
    summary.code = error.code;
  }
  return summary.name || summary.code ? summary : undefined;
}

function asIOError(message: string, cause: unknown): NodeAttachmentIOError {
  if (cause instanceof NodeAttachmentIOError) return cause;
  return new NodeAttachmentIOError("io", message, cause);
}

function asThrownError(error: unknown, message: string): Error {
  if (error instanceof NodeAttachmentIOError) return error;
  return new NodeAttachmentIOError("io", message, error);
}
