/** Schema version for persisted attachment references. */
export const ATTACHMENT_SCHEMA_VERSION = 1 as const;

/** Maximum image payload accepted by the local attachment foundation. */
export const ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;

export const ATTACHMENT_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
] as const;

export type AttachmentMediaType = (typeof ATTACHMENT_MEDIA_TYPES)[number];

/** Check the persisted vault identity shape without normalizing or deriving it. */
export function isValidAttachmentVaultId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !hasControlCharacter(value)
  );
}

/** Source metadata retained for one persisted reference, never used as a read capability. */
export type AttachmentSource =
  | {
      kind: "vault";
      readonly vaultId: string;
      vaultPath: string;
      sourceNotePath?: string;
    }
  | {
      kind: "external";
      displayName: string;
    };

/** Versioned JSON-safe record stored for one opaque attachment reference. */
export interface PersistentAttachmentRef {
  readonly schemaVersion: typeof ATTACHMENT_SCHEMA_VERSION;
  /** Unique opaque reference identity; different sources may point to one digest. */
  readonly attachmentId: string;
  readonly mediaType: AttachmentMediaType;
  readonly extension: string;
  readonly byteLength: number;
  readonly contentDigest: string;
  readonly source: AttachmentSource;
}

/** Input accepted by the explicit persistence operation. */
export interface PutAttachmentInput {
  readonly bytes: ArrayBuffer;
  readonly source: AttachmentSource;
  /** Optional declared MIME type passed to the shared image inspector. */
  readonly mediaType?: string;
  /** Descriptive alias for callers that use the inspector's terminology. */
  readonly declaredMediaType?: string;
}

/**
 * Storage boundary for the core store. Implementations own path selection and
 * atomicity; the core passes only digest/reference keys and JSON-safe records.
 */
export interface BinaryAttachmentIO {
  /** Return whether the content-addressed blob is present. */
  blobExists(contentDigest: string): Promise<boolean>;
  /** Read one blob by digest, or return null when it is absent. */
  readBlob(contentDigest: string): Promise<ArrayBuffer | null>;
  /** Atomically install one digest-addressed blob without exposing partial bytes. */
  writeBlobAtomic(contentDigest: string, bytes: ArrayBuffer): Promise<void>;
  /** Read one persisted reference record, or return null when it is absent. */
  readRecord(attachmentId: string): Promise<unknown>;
  /**
   * Atomically create one persisted reference record without replacing an
   * existing id. A collision must reject with a reference-id-collision error.
   */
  writeRecordAtomic(attachmentId: string, record: PersistentAttachmentRef): Promise<void>;
  /** Remove only one reference record; implementations must not remove blobs here. */
  removeRecord(attachmentId: string): Promise<void>;
}

export type AttachmentReferenceIdFactory = () => string;

export interface AttachmentStoreOptions {
  /** Lower per-store byte limit used by tests or a later product policy. */
  readonly maxBytes?: number;
  /** Injectable opaque-id source; the default uses Web Crypto. */
  readonly createReferenceId?: AttachmentReferenceIdFactory;
  /** Maximum attempts used to avoid overwriting an existing reference. */
  readonly maxReferenceIdAttempts?: number;
}

export type AttachmentStoreErrorCode =
  | "invalid-input"
  | "invalid-reference-id"
  | "invalid-record"
  | "integrity"
  | "reference-id-collision"
  | "size-limit";

/** Typed failures for store-owned validation and integrity boundaries. */
export class AttachmentStoreError extends Error {
  constructor(
    readonly code: AttachmentStoreErrorCode,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "AttachmentStoreError";
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
