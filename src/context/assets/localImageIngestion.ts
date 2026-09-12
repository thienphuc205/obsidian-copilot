import type {
  LocalImageReader,
  LocalImageRejectionReason,
  LocalImageResolution,
  LocalSourceRef,
} from "./assetTypes";
import type { AttachmentStore } from "./attachmentStore";
import type { AttachmentSource, PersistentAttachmentRef } from "./attachmentStoreTypes";
import { resolveEmbeddedLocalImage } from "./embeddedAssetResolver";
import { MAX_LOCAL_IMAGE_BYTES } from "./assetTypes";

/** Default number of explicit image references accepted by one ingestion call. */
export const DEFAULT_LOCAL_IMAGE_INGESTION_MAX_COUNT = 16;

/** Default aggregate byte budget for one explicit ingestion call. */
export const DEFAULT_LOCAL_IMAGE_INGESTION_MAX_BYTES =
  MAX_LOCAL_IMAGE_BYTES * DEFAULT_LOCAL_IMAGE_INGESTION_MAX_COUNT;

const MAX_INPUT_COUNT = 64;
const MAX_REFERENCE_LENGTH = 4096;
const MAX_AGGREGATE_BYTES = MAX_LOCAL_IMAGE_BYTES * MAX_INPUT_COUNT;

/** One explicit, user-triggered image destination to resolve and persist. */
export interface LocalImageIngestionInput {
  readonly reference: string;
  readonly sourceNotePath?: string;
}

/** Minimal injected write surface implemented by {@link AttachmentStore}. */
export type LocalImageAttachmentStore = Pick<AttachmentStore, "put">;

export interface LocalImageIngestionOptions {
  /** Already-authorized host reader used by the shared local resolver. */
  readonly reader: LocalImageReader;
  /** Injected device-local store; this service never selects its storage root. */
  readonly store: LocalImageAttachmentStore;
  /** Maximum number of references that may be persisted by one call. */
  readonly maxCount?: number;
  /** Maximum aggregate image bytes that may be persisted by one call. */
  readonly maxBytes?: number;
}

export type LocalImageIngestionRejectedReason = LocalImageRejectionReason;

export interface LocalImageIngestionPersisted {
  readonly status: "persisted";
  /** Bounded input destination, retained for per-reference result correlation. */
  readonly reference: string;
  /** Full source identity returned by the resolver; metadata is not a read capability. */
  readonly source: LocalSourceRef;
  /** Opaque persisted reference; image bytes are intentionally not returned. */
  readonly attachment: PersistentAttachmentRef;
}

export interface LocalImageIngestionSkipped {
  readonly status: "skipped";
  readonly reason: "budget-exceeded";
  readonly reference: string;
  readonly source?: LocalSourceRef;
}

export interface LocalImageIngestionRejected {
  readonly status: "rejected";
  readonly reason: LocalImageIngestionRejectedReason;
  readonly reference: string;
  readonly source?: LocalSourceRef;
}

export interface LocalImageIngestionFailed {
  readonly status: "failed";
  readonly reason: "storage-failed";
  readonly reference: string;
  readonly source: LocalSourceRef;
}

export type LocalImageIngestionItem =
  | LocalImageIngestionPersisted
  | LocalImageIngestionSkipped
  | LocalImageIngestionRejected
  | LocalImageIngestionFailed;

export interface LocalImageIngestionResult {
  readonly items: readonly LocalImageIngestionItem[];
  readonly persisted: readonly PersistentAttachmentRef[];
  readonly persistedCount: number;
  readonly persistedBytes: number;
}

export interface LocalImageIngestionService {
  /** Resolve and persist only the supplied destinations, in input order. */
  ingest(inputs: readonly LocalImageIngestionInput[]): Promise<LocalImageIngestionResult>;
}

/**
 * Creates an explicit local-image ingestion composition.
 *
 * Resolution is deliberately sequential so aggregate budgets are checked
 * immediately before each store write. A rejected or failed item does not
 * roll back earlier successes; a store may retain an orphaned content blob
 * when its reference write fails, according to the store's deletion policy.
 * Persisted ids are opaque and this service has no restore/read method: a
 * later restore must reapply the current strict scope policy instead of
 * treating cached bytes or source metadata as authorization.
 */
export function createLocalImageIngestion(
  options: LocalImageIngestionOptions
): LocalImageIngestionService {
  if (!isIngestionOptions(options)) {
    throw new Error("Local image ingestion options are invalid");
  }

  const maxCount = validateLimit(
    options.maxCount,
    DEFAULT_LOCAL_IMAGE_INGESTION_MAX_COUNT,
    MAX_INPUT_COUNT,
    "count"
  );
  const maxBytes = validateLimit(
    options.maxBytes,
    DEFAULT_LOCAL_IMAGE_INGESTION_MAX_BYTES,
    MAX_AGGREGATE_BYTES,
    "byte"
  );

  return {
    async ingest(inputs) {
      validateInputs(inputs);

      const items: LocalImageIngestionItem[] = [];
      const persisted: PersistentAttachmentRef[] = [];
      let persistedBytes = 0;

      for (const input of inputs) {
        const reference = boundReference(input.reference);
        if (persisted.length >= maxCount) {
          items.push({ status: "skipped", reason: "budget-exceeded", reference });
          continue;
        }

        let resolution: LocalImageResolution;
        try {
          resolution = await resolveEmbeddedLocalImage(
            input.reference,
            input.sourceNotePath,
            options.reader
          );
        } catch {
          // The shared resolver normally returns a typed rejection. Keep this
          // outer boundary sanitized if a malformed injected reader escapes it.
          items.push({ status: "rejected", reason: "not-found", reference });
          continue;
        }

        if (resolution.status === "rejected") {
          items.push(resolution);
          continue;
        }

        const source = resolution.source;
        const byteLength = resolution.bytes.byteLength;
        if (persistedBytes > maxBytes - byteLength) {
          items.push({ status: "skipped", reason: "budget-exceeded", reference, source });
          continue;
        }

        try {
          const attachment = await options.store.put({
            bytes: resolution.bytes,
            mediaType: resolution.mimeType,
            source: toAttachmentSource(source),
          });
          persisted.push(attachment);
          persistedBytes += byteLength;
          items.push({ status: "persisted", reference, source, attachment });
        } catch {
          // No cleanup is attempted here: the store owns its retained orphan
          // blob policy, and this layer must not delete another reference's data.
          items.push({ status: "failed", reason: "storage-failed", reference, source });
        }
      }

      return {
        items,
        persisted,
        persistedCount: persisted.length,
        persistedBytes,
      };
    },
  };
}

function isIngestionOptions(value: unknown): value is LocalImageIngestionOptions {
  if (!isRecord(value) || !isRecord(value.reader) || !isRecord(value.store)) {
    return false;
  }
  return (
    typeof value.reader.resolveLink === "function" &&
    typeof value.reader.readBinary === "function" &&
    typeof value.reader.getVaultId === "function" &&
    typeof value.reader.authorizeResolvedFile === "function" &&
    typeof value.store.put === "function"
  );
}

function validateLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string
): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit <= 0 || limit > maximum) {
    throw new Error(`Local image ingestion ${label} limit is invalid`);
  }
  return limit;
}

function validateInputs(value: unknown): asserts value is readonly LocalImageIngestionInput[] {
  if (!Array.isArray(value) || value.length > MAX_INPUT_COUNT) {
    throw new Error("Local image ingestion input count is invalid");
  }
  for (const input of value) {
    if (
      !isRecord(input) ||
      typeof input.reference !== "string" ||
      (input.sourceNotePath !== undefined && typeof input.sourceNotePath !== "string")
    ) {
      throw new Error("Local image ingestion input is invalid");
    }
  }
}

type LocalVaultAttachmentSource = Extract<AttachmentSource, { kind: "vault" }> & {
  readonly vaultId: string;
};

function toAttachmentSource(source: LocalSourceRef): LocalVaultAttachmentSource {
  return {
    kind: "vault",
    vaultId: source.vaultId,
    vaultPath: source.vaultPath,
    ...(source.sourceNotePath ? { sourceNotePath: source.sourceNotePath } : {}),
  };
}

function boundReference(reference: string): string {
  return reference.length <= MAX_REFERENCE_LENGTH
    ? reference
    : reference.slice(0, MAX_REFERENCE_LENGTH);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
