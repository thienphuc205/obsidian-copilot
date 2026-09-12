import {
  AttachmentStoreError,
  isValidAttachmentVaultId,
  type PersistentAttachmentRef,
} from "./attachmentStoreTypes";

const REFERENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Version for the untrusted chat-to-attachment reference envelope. */
export const ATTACHMENT_REFERENCE_ENVELOPE_SCHEMA_VERSION = 1 as const;

/** Untrusted descriptive metadata used to request one local attachment. */
export interface AttachmentRestoreEnvelope {
  readonly schemaVersion: typeof ATTACHMENT_REFERENCE_ENVELOPE_SCHEMA_VERSION;
  readonly vaultId: string;
  readonly attachmentId: string;
}

export type AuthorizedAttachmentRestoreErrorCode =
  | "invalid-request"
  | "not-found"
  | "foreign-vault"
  | "unsupported-source"
  | "authorization-denied"
  | "invalid-record"
  | "integrity"
  | "storage-unavailable";

/** Sanitized failures returned by the explicit authorized-restore boundary. */
export class AuthorizedAttachmentRestoreError extends Error {
  constructor(
    readonly code: AuthorizedAttachmentRestoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AuthorizedAttachmentRestoreError";
  }
}

/** Minimal store surface needed by the authorization-aware restore service. */
export interface AuthorizedAttachmentStore {
  inspectMetadata(attachmentId: string): Promise<PersistentAttachmentRef | null>;
  read(
    attachmentId: string,
    expectedMetadata?: PersistentAttachmentRef
  ): Promise<ArrayBuffer | null>;
}

/** Dependencies for one explicit current-vault restore scope. */
export interface AuthorizedAttachmentRestoreOptions {
  /** Store containing authoritative records and digest-addressed bytes. */
  readonly store: AuthorizedAttachmentStore;
  /** Current vault identity supplied by the host, never inferred from the envelope. */
  readonly currentVaultId: string;
  /** Host policy check for the authoritative vault-relative source path. */
  readonly authorizeVaultPath: (vaultPath: string) => boolean | Promise<boolean>;
}

/** Authorized restore operations bound to one explicit current vault identity. */
export interface AuthorizedAttachmentRestore {
  /** Inspect, authorize, and return one verified attachment payload. */
  restore(envelope: unknown): Promise<ArrayBuffer>;
}

/**
 * Create a restore boundary that cannot read a blob without host authorization.
 *
 * Metadata is checked before the first authorization and the policy is checked
 * again after the asynchronous blob read. The second check narrows the
 * revocation window but cannot provide an OS or agent sandbox guarantee against
 * a concurrent change after it returns.
 *
 * @param options Explicit store, current vault identity, and host authorization.
 * @returns Restore operations for the supplied vault scope.
 */
export function createAuthorizedAttachmentRestore(
  options: AuthorizedAttachmentRestoreOptions
): AuthorizedAttachmentRestore {
  if (
    !isRecord(options) ||
    !isRecord(options.store) ||
    typeof options.store.inspectMetadata !== "function" ||
    typeof options.store.read !== "function" ||
    !isValidAttachmentVaultId(options.currentVaultId) ||
    typeof options.authorizeVaultPath !== "function"
  ) {
    throw new AuthorizedAttachmentRestoreError(
      "invalid-request",
      "Attachment restore options are invalid"
    );
  }

  const currentVaultId = options.currentVaultId;

  return {
    async restore(envelope) {
      const request = validateEnvelope(envelope);
      if (request.vaultId !== currentVaultId) {
        throw new AuthorizedAttachmentRestoreError(
          "foreign-vault",
          "Attachment reference belongs to another vault"
        );
      }

      let metadata: PersistentAttachmentRef | null;
      try {
        metadata = await options.store.inspectMetadata(request.attachmentId);
      } catch (error) {
        throw mapStoreError(error, "Attachment reference metadata is unavailable");
      }
      if (metadata === null) {
        throw new AuthorizedAttachmentRestoreError(
          "not-found",
          "Attachment reference was not found"
        );
      }
      if (metadata.source.kind !== "vault") {
        throw new AuthorizedAttachmentRestoreError(
          "unsupported-source",
          "Attachment source is not supported for restore"
        );
      }
      if (
        metadata.source.vaultId !== currentVaultId ||
        metadata.source.vaultId !== request.vaultId
      ) {
        throw new AuthorizedAttachmentRestoreError(
          "foreign-vault",
          "Attachment reference belongs to another vault"
        );
      }

      await authorize(options.authorizeVaultPath, metadata.source.vaultPath);

      let bytes: ArrayBuffer | null;
      try {
        bytes = await options.store.read(request.attachmentId, metadata);
      } catch (error) {
        throw mapStoreError(error, "Attachment bytes could not be restored");
      }

      await authorize(options.authorizeVaultPath, metadata.source.vaultPath);
      if (bytes === null) {
        throw new AuthorizedAttachmentRestoreError(
          "not-found",
          "Attachment reference was not found"
        );
      }
      return bytes;
    },
  };
}

function validateEnvelope(value: unknown): AttachmentRestoreEnvelope {
  if (
    !isRecord(value) ||
    value.schemaVersion !== ATTACHMENT_REFERENCE_ENVELOPE_SCHEMA_VERSION ||
    !isValidAttachmentVaultId(value.vaultId) ||
    typeof value.attachmentId !== "string" ||
    !REFERENCE_ID_PATTERN.test(value.attachmentId)
  ) {
    throw new AuthorizedAttachmentRestoreError(
      "invalid-request",
      "Attachment reference envelope is invalid"
    );
  }
  return {
    schemaVersion: ATTACHMENT_REFERENCE_ENVELOPE_SCHEMA_VERSION,
    vaultId: value.vaultId,
    attachmentId: value.attachmentId,
  };
}

async function authorize(
  authorizeVaultPath: (vaultPath: string) => boolean | Promise<boolean>,
  vaultPath: string
): Promise<void> {
  try {
    if (!(await authorizeVaultPath(vaultPath))) {
      throw new AuthorizedAttachmentRestoreError(
        "authorization-denied",
        "Attachment path authorization was denied"
      );
    }
  } catch (error) {
    if (error instanceof AuthorizedAttachmentRestoreError) throw error;
    throw new AuthorizedAttachmentRestoreError(
      "authorization-denied",
      "Attachment path authorization failed"
    );
  }
}

function mapStoreError(error: unknown, fallbackMessage: string): AuthorizedAttachmentRestoreError {
  if (error instanceof AttachmentStoreError) {
    if (error.code === "invalid-record") {
      return new AuthorizedAttachmentRestoreError(
        "invalid-record",
        "Attachment reference record is invalid"
      );
    }
    if (error.code === "integrity" || error.code === "size-limit") {
      return new AuthorizedAttachmentRestoreError("integrity", "Attachment integrity failed");
    }
  }
  return new AuthorizedAttachmentRestoreError("storage-unavailable", fallbackMessage);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
