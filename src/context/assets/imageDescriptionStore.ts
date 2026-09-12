/**
 * Bounded, fail-closed persistence for image descriptions used by multimodal
 * retrieval. The store is keyed by content digest so the same image bytes map
 * to one description, and it never trusts the file it reads: every entry is
 * re-validated on load and invalid entries are silently dropped instead of
 * crashing the caller.
 *
 * The module owns no filesystem and no logging; persistence is delegated to an
 * injected IO adapter and callers own any observability around its failures.
 */

/** Schema version of the persisted JSON envelope. */
export const IMAGE_DESCRIPTION_SCHEMA_VERSION = 1 as const;

/** Maximum retained entries; putting beyond this evicts the oldest entry. */
export const IMAGE_DESCRIPTION_MAX_ENTRIES = 500;

/** Upper bound for a stored description, matching the describer's output cap. */
export const IMAGE_DESCRIPTION_MAX_LENGTH = 2000;

const MAX_VAULT_PATH_LENGTH = 1024;
const MAX_MODEL_LENGTH = 128;
const MAX_UPDATED_AT_LENGTH = 128;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

/** One persisted image description, addressed by the image's content digest. */
export interface ImageDescriptionEntry {
  /** Lowercase sha256 hex digest of the image bytes (exactly 64 characters). */
  readonly digest: string;
  readonly description: string;
  /** Optional vault-relative path of the image, retained as metadata only. */
  readonly vaultPath?: string;
  /** Optional name of the model that produced the description. */
  readonly model?: string;
  /** ISO timestamp of the last write, used for eviction and list ordering. */
  readonly updatedAt: string;
}

/** Input accepted by {@link ImageDescriptionStore.put}; updatedAt is optional. */
export interface PutImageDescriptionInput {
  readonly digest: string;
  readonly description: string;
  readonly vaultPath?: string;
  readonly model?: string;
  /** Defaults to the current time when omitted. */
  readonly updatedAt?: string;
}

/**
 * Storage boundary for the description store. Implementations own path
 * selection and atomicity; the core passes only the full file contents.
 */
export interface ImageDescriptionIO {
  /** Return the persisted envelope contents, or null when no file exists. */
  readFile(): Promise<string | null>;
  /** Replace the persisted envelope with the given JSON contents. */
  writeFile(contents: string): Promise<void>;
}

/** Failures raised by store-owned validation and persistence boundaries. */
export class ImageDescriptionStoreError extends Error {
  constructor(
    readonly code: "invalid-input" | "io",
    message: string
  ) {
    super(message);
    this.name = "ImageDescriptionStoreError";
  }
}

// Referential stability: list() on an empty store always returns this constant
// instead of a freshly allocated array.
const EMPTY_IMAGE_DESCRIPTIONS = Object.freeze([]) as readonly ImageDescriptionEntry[];
/**
 * Digest-keyed description cache with a hard entry cap. Reads are fail-closed:
 * a missing, corrupt, or future-version file behaves as an empty store rather
 * than throwing, so one bad write can never break retrieval.
 *
 * Write-failure semantics: the in-memory mutation is applied first, then
 * persisted. If writeFile rejects, the in-memory state is rolled back to the
 * pre-mutation snapshot and the error is rethrown as an "io" failure, so
 * memory always mirrors the last successfully persisted file. This assumes
 * the adapter's writeFile leaves the previous file intact when it rejects.
 */
export class ImageDescriptionStore {
  private entries: Map<string, ImageDescriptionEntry>;
  private readonly loadPromise: Promise<void>;

  constructor(private readonly io: ImageDescriptionIO) {
    this.entries = new Map();
    this.loadPromise = this.load();
  }

  /** Return the entry for one digest, or null when it is not stored. */
  async get(digest: string): Promise<ImageDescriptionEntry | null> {
    validateDigest(digest);
    await this.loadPromise;
    return this.entries.get(digest) ?? null;
  }

  /**
   * Validate and upsert one description, persisting the envelope afterwards.
   * A new digest beyond the entry cap evicts the oldest entry (updatedAt
   * ascending, tie-break by digest ascending) before the write.
   */
  async put(input: PutImageDescriptionInput): Promise<ImageDescriptionEntry> {
    const entry = this.normalizePutInput(input);
    await this.loadPromise;

    const snapshot = new Map(this.entries);
    if (!this.entries.has(entry.digest) && this.entries.size >= IMAGE_DESCRIPTION_MAX_ENTRIES) {
      this.entries.delete(findOldestDigest(this.entries));
    }
    this.entries.set(entry.digest, entry);
    try {
      await this.persist();
    } catch {
      this.entries = snapshot;
      throw new ImageDescriptionStoreError("io", "Image description store write failed");
    }
    return entry;
  }

  /** Return all entries ordered by updatedAt descending (digest desc on ties). */
  async list(): Promise<readonly ImageDescriptionEntry[]> {
    await this.loadPromise;
    if (this.entries.size === 0) return EMPTY_IMAGE_DESCRIPTIONS;
    return Object.freeze(
      [...this.entries.values()].sort(
        (a, b) =>
          Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.digest < b.digest ? 1 : -1)
      )
    );
  }

  /** Return the number of retained entries. */
  async size(): Promise<number> {
    await this.loadPromise;
    return this.entries.size;
  }

  private normalizePutInput(input: PutImageDescriptionInput): ImageDescriptionEntry {
    if (input === null || typeof input !== "object") {
      throw new ImageDescriptionStoreError(
        "invalid-input",
        "Image description put input is invalid"
      );
    }
    const normalized = normalizeImageDescriptionEntry({
      digest: input.digest,
      description: input.description,
      vaultPath: input.vaultPath,
      model: input.model,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    });
    if (normalized === null) {
      throw new ImageDescriptionStoreError(
        "invalid-input",
        "Image description entry violates a bound"
      );
    }
    return normalized;
  }

  private async load(): Promise<void> {
    const raw = await this.io.readFile();
    if (raw === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Fail closed: a corrupt file behaves as an empty store, never a throw.
      return;
    }
    if (!isRecord(parsed) || parsed.version !== IMAGE_DESCRIPTION_SCHEMA_VERSION) {
      // Unknown envelope versions are treated as empty until a reviewed
      // migration exists, so future schemas cannot crash older readers.
      return;
    }
    if (!Array.isArray(parsed.entries)) return;
    for (const value of parsed.entries) {
      const entry = normalizeImageDescriptionEntry(value);
      if (entry !== null) this.entries.set(entry.digest, entry);
    }
  }

  private async persist(): Promise<void> {
    const envelope = {
      version: IMAGE_DESCRIPTION_SCHEMA_VERSION,
      entries: Array.from(this.entries.values()),
    };
    await this.io.writeFile(JSON.stringify(envelope));
  }
}

/**
 * Validate one untrusted value as a stored entry.
 *
 * @param value Parsed JSON of unknown shape, e.g. from the persisted envelope.
 * @returns A frozen entry, or null when the value violates any bound so the
 * caller can drop it instead of crashing.
 */
export function normalizeImageDescriptionEntry(value: unknown): ImageDescriptionEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value.digest !== "string" || !DIGEST_PATTERN.test(value.digest)) return null;
  if (typeof value.description !== "string") return null;
  if (value.description.length === 0 || value.description.length > IMAGE_DESCRIPTION_MAX_LENGTH) {
    return null;
  }
  const vaultPath = normalizeOptionalText(value.vaultPath, MAX_VAULT_PATH_LENGTH);
  if (vaultPath === undefined && value.vaultPath !== undefined) return null;
  const model = normalizeOptionalText(value.model, MAX_MODEL_LENGTH);
  if (model === undefined && value.model !== undefined) return null;
  if (typeof value.updatedAt !== "string") return null;
  if (value.updatedAt.length === 0 || value.updatedAt.length > MAX_UPDATED_AT_LENGTH) return null;
  if (Number.isNaN(Date.parse(value.updatedAt))) return null;
  return Object.freeze({
    digest: value.digest,
    description: value.description,
    ...(vaultPath === undefined ? {} : { vaultPath }),
    ...(model === undefined ? {} : { model }),
    updatedAt: value.updatedAt,
  });
}

function normalizeOptionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return undefined;
  }
  return value;
}

function findOldestDigest(entries: Map<string, ImageDescriptionEntry>): string {
  let oldest: ImageDescriptionEntry | undefined;
  for (const entry of entries.values()) {
    if (
      oldest === undefined ||
      Date.parse(entry.updatedAt) - Date.parse(oldest.updatedAt) < 0 ||
      (Date.parse(entry.updatedAt) === Date.parse(oldest.updatedAt) && entry.digest < oldest.digest)
    ) {
      oldest = entry;
    }
  }
  return oldest?.digest ?? "";
}

function validateDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new ImageDescriptionStoreError(
      "invalid-input",
      "Image description digest must be 64 lowercase hex"
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- Vault adapter (merged from imageDescriptionVaultIO) ---
import type { Vault } from "obsidian";
/** Vault-relative path of the persisted image-description envelope. */
export const IMAGE_DESCRIPTIONS_STORE_PATH = ".copilot/image-descriptions.json";

/** Folder holding the envelope; matches the PDF cache's `.copilot/` storage root. */
const IMAGE_DESCRIPTIONS_DIR = ".copilot";

/**
 * Vault-backed IO adapter for the image description store: it owns how the
 * store's envelope is placed inside the vault's `.copilot/` folder and nothing
 * else. Reads are fail-closed — a missing or unreadable file is reported as
 * null so the store treats it as empty — while write failures propagate so the
 * store can roll back its in-memory state.
 *
 * @param vault The Obsidian vault whose adapter persists the store file.
 * @returns An IO adapter bound to the vault's filesystem.
 */
export function createVaultImageDescriptionIO(vault: Vault): ImageDescriptionIO {
  return {
    async readFile(): Promise<string | null> {
      try {
        if (!(await vault.adapter.exists(IMAGE_DESCRIPTIONS_STORE_PATH))) {
          return null;
        }
        return await vault.adapter.read(IMAGE_DESCRIPTIONS_STORE_PATH);
      } catch {
        // Fail closed like the PDF cache: an unreadable store behaves as
        // absent rather than breaking the caller.
        return null;
      }
    },

    async writeFile(contents: string): Promise<void> {
      if (!(await vault.adapter.exists(IMAGE_DESCRIPTIONS_DIR))) {
        await vault.adapter.mkdir(IMAGE_DESCRIPTIONS_DIR);
      }
      await vault.adapter.write(IMAGE_DESCRIPTIONS_STORE_PATH, contents);
    },
  };
}
