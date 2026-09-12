import { inspectLocalImage } from "./imageValidation";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MEDIA_TYPES,
  ATTACHMENT_SCHEMA_VERSION,
  AttachmentStoreError,
  isValidAttachmentVaultId,
  type AttachmentMediaType,
  type AttachmentReferenceIdFactory,
  type AttachmentSource,
  type AttachmentStoreOptions,
  type BinaryAttachmentIO,
  type PersistentAttachmentRef,
  type PutAttachmentInput,
} from "./attachmentStoreTypes";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const EXTENSION_PATTERN = /^[a-z0-9]{1,8}$/;
const DEFAULT_REFERENCE_ID_ATTEMPTS = 16;

const MEDIA_TYPE_BY_EXTENSION: Record<string, AttachmentMediaType> = {
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const SUPPORTED_MEDIA_TYPES = new Set<string>(ATTACHMENT_MEDIA_TYPES);

/**
 * Device-local attachment store core. It owns references and integrity checks,
 * but never chooses a filesystem path or creates persistence by itself.
 *
 * Blobs are keyed by content digest while records are keyed by unique opaque
 * attachment ids. Removing a record therefore cannot remove bytes still
 * referenced by another record; unreferenced blobs are deliberately retained
 * for a future, separately reviewed garbage-collection policy.
 */
export class AttachmentStore {
  private readonly maxBytes: number;
  private readonly createReferenceId: AttachmentReferenceIdFactory;
  private readonly maxReferenceIdAttempts: number;

  constructor(
    private readonly io: BinaryAttachmentIO,
    options: AttachmentStoreOptions = {}
  ) {
    this.maxBytes = validateMaxBytes(options.maxBytes);
    this.createReferenceId = options.createReferenceId ?? createOpaqueReferenceId;
    this.maxReferenceIdAttempts = validateAttemptLimit(options.maxReferenceIdAttempts);
  }

  /**
   * Validate and explicitly persist one image reference and its content blob.
   *
   * @param input Image bytes and caller-provided source metadata to retain.
   * @returns The versioned opaque reference record written by the operation.
   */
  async put(input: PutAttachmentInput): Promise<PersistentAttachmentRef> {
    if (!input || !(input.bytes instanceof ArrayBuffer)) {
      throw new AttachmentStoreError("invalid-input", "Attachment bytes must be an ArrayBuffer");
    }
    if (input.bytes.byteLength > this.maxBytes) {
      throw new AttachmentStoreError(
        "size-limit",
        `Attachment exceeds the ${this.maxBytes}-byte limit`
      );
    }

    const source = validateSource(input.source);
    const declaredMediaType = resolveDeclaredMediaType(input);
    const inspection = await inspectLocalImage(input.bytes, declaredMediaType);
    const checked = validateInspection(inspection, input.bytes.byteLength, this.maxBytes);
    await this.ensureBlob(checked, input.bytes);

    const recordBase: Omit<PersistentAttachmentRef, "attachmentId"> = {
      schemaVersion: ATTACHMENT_SCHEMA_VERSION,
      mediaType: checked.mediaType,
      extension: checked.extension,
      byteLength: checked.byteLength,
      contentDigest: checked.contentDigest,
      source,
    };
    return this.writeUniqueRecord(recordBase);
  }

  /**
   * Read and verify one persisted reference. A missing reference returns null;
   * a present record with missing or changed bytes is an integrity failure.
   *
   * @param attachmentId Opaque reference id returned by {@link put}.
   * @param expectedMetadata Optional metadata snapshot that must still match
   * before the blob is read.
   * @returns A defensive copy of the verified bytes, or null when no record exists.
   */
  async read(
    attachmentId: string,
    expectedMetadata?: PersistentAttachmentRef
  ): Promise<ArrayBuffer | null> {
    const record = await this.inspectMetadata(attachmentId);
    if (record === null) return null;
    if (expectedMetadata !== undefined && !sameRecord(record, expectedMetadata)) {
      throw new AttachmentStoreError(
        "integrity",
        "Attachment record changed before its content was read"
      );
    }
    const bytes = await this.io.readBlob(record.contentDigest);
    if (bytes === null) {
      throw new AttachmentStoreError(
        "integrity",
        `Attachment ${attachmentId} references a missing content blob`
      );
    }
    await this.verifyBlob(record, bytes);
    return bytes.slice(0);
  }

  /**
   * Validate and return one persisted reference without reading its blob.
   *
   * @param attachmentId Opaque reference id whose record should be inspected.
   * @returns The validated authoritative metadata, or null when no record exists.
   */
  async inspectMetadata(attachmentId: string): Promise<PersistentAttachmentRef | null> {
    validateReferenceId(attachmentId);
    const rawRecord = await this.io.readRecord(attachmentId);
    if (rawRecord === null) return null;
    return validateRecord(rawRecord, attachmentId, this.maxBytes);
  }

  /**
   * Remove exactly one reference record. The digest-addressed blob is never
   * deleted because another reference may share it, and automatic GC is out of
   * scope for this core.
   *
   * @param attachmentId Opaque reference id to remove.
   */
  async remove(attachmentId: string): Promise<void> {
    validateReferenceId(attachmentId);
    const rawRecord = await this.io.readRecord(attachmentId);
    if (rawRecord === null) return;
    await this.io.removeRecord(attachmentId);
  }

  private async writeUniqueRecord(
    recordBase: Omit<PersistentAttachmentRef, "attachmentId">
  ): Promise<PersistentAttachmentRef> {
    for (let attempt = 0; attempt < this.maxReferenceIdAttempts; attempt += 1) {
      const attachmentId = this.createReferenceId();
      validateReferenceId(attachmentId);

      if ((await this.io.readRecord(attachmentId)) !== null) continue;

      const record: PersistentAttachmentRef = { ...recordBase, attachmentId };
      try {
        await this.io.writeRecordAtomic(attachmentId, record);
      } catch (error) {
        // The read-before-write is only an optimization; the adapter's
        // create-only operation closes the race between concurrent writers.
        if (isReferenceIdCollision(error)) continue;
        throw error;
      }

      // A successful atomic write is expected to be immediately readable. The
      // read-back catches a faulty adapter before a caller treats the reference
      // as durable, while leaving any already-written bytes for safe later GC.
      const persisted = await this.io.readRecord(attachmentId);
      const verified = validateRecord(persisted, attachmentId, this.maxBytes);
      if (!sameRecord(record, verified)) {
        throw new AttachmentStoreError(
          "integrity",
          `Attachment reference ${attachmentId} changed during atomic write`
        );
      }
      return verified;
    }
    throw new AttachmentStoreError(
      "reference-id-collision",
      "Could not allocate a unique attachment reference id"
    );
  }

  private async ensureBlob(inspection: ImageInspection, bytes: ArrayBuffer): Promise<void> {
    if (await this.io.blobExists(inspection.contentDigest)) {
      const existing = await this.io.readBlob(inspection.contentDigest);
      if (existing === null) {
        throw new AttachmentStoreError(
          "integrity",
          `Blob ${inspection.contentDigest} disappeared during read`
        );
      }
      await this.verifyBlobAgainstInspection(inspection, existing);
      return;
    }

    // The adapter's atomic operation receives a copy so it cannot mutate the
    // caller's live bytes while writing.
    await this.io.writeBlobAtomic(inspection.contentDigest, bytes.slice(0));
    if (!(await this.io.blobExists(inspection.contentDigest))) {
      throw new AttachmentStoreError(
        "integrity",
        `Blob ${inspection.contentDigest} was not present after atomic write`
      );
    }
    const written = await this.io.readBlob(inspection.contentDigest);
    if (written === null) {
      throw new AttachmentStoreError(
        "integrity",
        `Blob ${inspection.contentDigest} could not be read after atomic write`
      );
    }
    await this.verifyBlobAgainstInspection(inspection, written);
  }

  private async verifyBlob(record: PersistentAttachmentRef, bytes: ArrayBuffer): Promise<void> {
    await this.verifyBlobAgainstInspection(record, bytes);
  }

  private async verifyBlobAgainstInspection(
    expected: ImageInspection | PersistentAttachmentRef,
    bytes: ArrayBuffer
  ): Promise<void> {
    if (bytes.byteLength > this.maxBytes) {
      throw new AttachmentStoreError(
        "size-limit",
        `Stored attachment exceeds the ${this.maxBytes}-byte limit`
      );
    }

    let inspection: unknown;
    try {
      inspection = await inspectLocalImage(bytes, expected.mediaType);
    } catch (error) {
      throw new AttachmentStoreError(
        "integrity",
        "Stored attachment bytes failed image validation",
        error
      );
    }
    const checked = validateInspection(inspection, bytes.byteLength, this.maxBytes);
    if (
      checked.contentDigest !== expected.contentDigest ||
      checked.byteLength !== expected.byteLength ||
      checked.mediaType !== expected.mediaType ||
      checked.extension !== expected.extension
    ) {
      throw new AttachmentStoreError(
        "integrity",
        `Stored attachment ${expected.contentDigest} does not match its reference`
      );
    }
  }
}

function isReferenceIdCollision(error: unknown): boolean {
  return error instanceof AttachmentStoreError && error.code === "reference-id-collision";
}

interface ImageInspection {
  readonly mediaType: AttachmentMediaType;
  readonly extension: string;
  readonly byteLength: number;
  readonly contentDigest: string;
}

function validateMaxBytes(value: number | undefined): number {
  const maxBytes = value ?? ATTACHMENT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > ATTACHMENT_MAX_BYTES) {
    throw new AttachmentStoreError("invalid-input", "Attachment byte limit is invalid");
  }
  return maxBytes;
}

function validateAttemptLimit(value: number | undefined): number {
  const attempts = value ?? DEFAULT_REFERENCE_ID_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts <= 0 || attempts > 100) {
    throw new AttachmentStoreError(
      "invalid-input",
      "Attachment reference attempt limit is invalid"
    );
  }
  return attempts;
}

function resolveDeclaredMediaType(input: PutAttachmentInput): string | undefined {
  if (
    input.mediaType !== undefined &&
    input.declaredMediaType !== undefined &&
    input.mediaType !== input.declaredMediaType
  ) {
    throw new AttachmentStoreError(
      "invalid-input",
      "mediaType and declaredMediaType must agree when both are supplied"
    );
  }
  return input.mediaType ?? input.declaredMediaType;
}

function validateInspection(value: unknown, byteLength: number, maxBytes: number): ImageInspection {
  if (!isRecord(value)) {
    throw new AttachmentStoreError("integrity", "Image inspector returned an invalid result");
  }
  const mediaType = normalizeMediaType(value.mediaType);
  const extension = normalizeExtension(value.extension);
  if (MEDIA_TYPE_BY_EXTENSION[extension] !== mediaType) {
    throw new AttachmentStoreError(
      "integrity",
      `Image inspector returned mismatched media type and extension`
    );
  }
  if (value.byteLength !== byteLength || !Number.isInteger(value.byteLength)) {
    throw new AttachmentStoreError("integrity", "Image inspector returned an invalid byte length");
  }
  if (byteLength <= 0 || byteLength > maxBytes) {
    throw new AttachmentStoreError("size-limit", `Attachment exceeds the ${maxBytes}-byte limit`);
  }
  if (typeof value.contentDigest !== "string" || !DIGEST_PATTERN.test(value.contentDigest)) {
    throw new AttachmentStoreError(
      "integrity",
      "Image inspector returned an invalid content digest"
    );
  }
  return {
    mediaType,
    extension,
    byteLength,
    contentDigest: value.contentDigest,
  };
}

function normalizeMediaType(value: unknown): AttachmentMediaType {
  if (typeof value !== "string") {
    throw new AttachmentStoreError("integrity", "Image inspector returned an invalid media type");
  }
  const mediaType = value.toLowerCase();
  if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) {
    throw new AttachmentStoreError("integrity", `Unsupported stored image media type: ${value}`);
  }
  return mediaType as AttachmentMediaType;
}

function normalizeExtension(value: unknown): string {
  if (typeof value !== "string") {
    throw new AttachmentStoreError("integrity", "Image inspector returned an invalid extension");
  }
  const extension = value.startsWith(".") ? value.slice(1) : value;
  if (!EXTENSION_PATTERN.test(extension.toLowerCase())) {
    throw new AttachmentStoreError("integrity", "Image inspector returned an invalid extension");
  }
  return extension.toLowerCase();
}

function validateRecord(
  value: unknown,
  expectedAttachmentId: string,
  maxBytes: number
): PersistentAttachmentRef {
  if (!isRecord(value)) {
    throw new AttachmentStoreError("invalid-record", "Attachment record is not an object");
  }
  if (value.schemaVersion !== ATTACHMENT_SCHEMA_VERSION) {
    throw new AttachmentStoreError(
      "invalid-record",
      "Attachment record schema version is unsupported"
    );
  }
  if (value.attachmentId !== expectedAttachmentId) {
    throw new AttachmentStoreError("invalid-record", "Attachment record id does not match its key");
  }
  validateReferenceId(expectedAttachmentId);
  const mediaType = normalizeMediaType(value.mediaType);
  const extension = normalizeExtension(value.extension);
  if (MEDIA_TYPE_BY_EXTENSION[extension] !== mediaType) {
    throw new AttachmentStoreError(
      "invalid-record",
      "Attachment record media metadata is inconsistent"
    );
  }
  if (
    typeof value.byteLength !== "number" ||
    !Number.isInteger(value.byteLength) ||
    value.byteLength <= 0 ||
    value.byteLength > maxBytes
  ) {
    throw new AttachmentStoreError("invalid-record", "Attachment record byte length is invalid");
  }
  if (typeof value.contentDigest !== "string" || !DIGEST_PATTERN.test(value.contentDigest)) {
    throw new AttachmentStoreError("invalid-record", "Attachment record digest is invalid");
  }
  let source: AttachmentSource;
  try {
    source = validateSource(value.source);
  } catch (error) {
    throw new AttachmentStoreError(
      "invalid-record",
      "Attachment record source metadata is invalid",
      error
    );
  }
  return {
    schemaVersion: ATTACHMENT_SCHEMA_VERSION,
    attachmentId: expectedAttachmentId,
    mediaType,
    extension,
    byteLength: value.byteLength,
    contentDigest: value.contentDigest,
    source,
  };
}

function validateSource(value: unknown): AttachmentSource {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new AttachmentStoreError("invalid-input", "Attachment source metadata is invalid");
  }
  if (value.kind === "vault") {
    const vaultId = validateVaultId(value.vaultId);
    const vaultPath = validateRelativePath(value.vaultPath, "vaultPath");
    let sourceNotePath: string | undefined;
    if (value.sourceNotePath !== undefined) {
      sourceNotePath = validateRelativePath(value.sourceNotePath, "sourceNotePath");
    }
    return {
      kind: "vault",
      vaultId,
      vaultPath,
      ...(sourceNotePath ? { sourceNotePath } : {}),
    };
  }
  if (value.kind === "external") {
    if (typeof value.displayName !== "string") {
      throw new AttachmentStoreError(
        "invalid-input",
        "External attachment display name is invalid"
      );
    }
    const displayName = value.displayName;
    if (
      displayName.length === 0 ||
      displayName.length > 512 ||
      displayName.trim() !== displayName ||
      displayName.includes("\0") ||
      displayName.includes("/") ||
      displayName.includes("\\") ||
      displayName.includes(":") ||
      /^[A-Za-z]:/.test(displayName)
    ) {
      throw new AttachmentStoreError(
        "invalid-input",
        "External attachment display name is invalid"
      );
    }
    return { kind: "external", displayName };
  }
  throw new AttachmentStoreError("invalid-input", "Attachment source kind is unsupported");
}

function validateVaultId(value: unknown): string {
  if (!isValidAttachmentVaultId(value)) {
    throw new AttachmentStoreError("invalid-input", "Attachment vault identity is invalid");
  }
  return value;
}

function validateRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new AttachmentStoreError("invalid-input", `${label} must be a string`);
  }
  if (
    value.length === 0 ||
    value.length > 4096 ||
    value.trim() !== value ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.startsWith("//") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) {
    throw new AttachmentStoreError("invalid-input", `${label} must be vault-relative metadata`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new AttachmentStoreError(
      "invalid-input",
      `${label} must be normalized vault-relative metadata`
    );
  }
  return value;
}

function validateReferenceId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !REFERENCE_ID_PATTERN.test(value)) {
    throw new AttachmentStoreError("invalid-reference-id", "Attachment reference id is invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameRecord(a: PersistentAttachmentRef, b: PersistentAttachmentRef): boolean {
  return (
    a.schemaVersion === b.schemaVersion &&
    a.attachmentId === b.attachmentId &&
    a.mediaType === b.mediaType &&
    a.extension === b.extension &&
    a.byteLength === b.byteLength &&
    a.contentDigest === b.contentDigest &&
    sameSource(a.source, b.source)
  );
}

function sameSource(a: AttachmentSource, b: AttachmentSource): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "external" && b.kind === "external") {
    return a.displayName === b.displayName;
  }
  if (a.kind === "vault" && b.kind === "vault") {
    return (
      a.vaultId === b.vaultId &&
      a.vaultPath === b.vaultPath &&
      a.sourceNotePath === b.sourceNotePath
    );
  }
  return false;
}

function createOpaqueReferenceId(): string {
  const cryptoApi = window.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return `att_${cryptoApi.randomUUID()}`;
  }
  if (cryptoApi?.getRandomValues) {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    let hex = "";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return `att_${hex}`;
  }
  throw new AttachmentStoreError(
    "invalid-input",
    "Web Crypto is required for attachment references"
  );
}
