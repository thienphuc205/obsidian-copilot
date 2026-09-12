import { inspectLocalImage } from "./imageValidation";
import {
  ATTACHMENT_SCHEMA_VERSION,
  AttachmentStoreError,
  type AttachmentSource,
  type BinaryAttachmentIO,
  type PersistentAttachmentRef,
} from "./attachmentStoreTypes";
import { AttachmentStore } from "./attachmentStore";

jest.mock("./imageValidation", () => ({
  inspectLocalImage: jest.fn(),
}));

const mockInspectLocalImage = jest.mocked(inspectLocalImage);

class FaultInjectionAttachmentIO implements BinaryAttachmentIO {
  readonly blobs = new Map<string, ArrayBuffer>();
  readonly records = new Map<string, unknown>();
  readonly blobExistsCalls: string[] = [];
  readonly readBlobCalls: string[] = [];
  readonly writeBlobCalls: string[] = [];
  readonly writeRecordCalls: string[] = [];
  readonly removeRecordCalls: string[] = [];
  failBlobWrite = false;
  failRecordWrite = false;

  async blobExists(contentDigest: string): Promise<boolean> {
    this.blobExistsCalls.push(contentDigest);
    return this.blobs.has(contentDigest);
  }

  async readBlob(contentDigest: string): Promise<ArrayBuffer | null> {
    this.readBlobCalls.push(contentDigest);
    return this.blobs.get(contentDigest)?.slice(0) ?? null;
  }

  async writeBlobAtomic(contentDigest: string, bytes: ArrayBuffer): Promise<void> {
    this.writeBlobCalls.push(contentDigest);
    if (this.failBlobWrite) throw new Error("injected blob write failure");
    this.blobs.set(contentDigest, bytes.slice(0));
  }

  async readRecord(attachmentId: string): Promise<unknown> {
    const record = this.records.get(attachmentId);
    if (record === undefined) return null;
    return cloneRecord(record as PersistentAttachmentRef);
  }

  async writeRecordAtomic(attachmentId: string, record: PersistentAttachmentRef): Promise<void> {
    this.writeRecordCalls.push(attachmentId);
    if (this.failRecordWrite) throw new Error("injected record write failure");
    if (this.records.has(attachmentId)) {
      throw new AttachmentStoreError(
        "reference-id-collision",
        "injected record reference collision"
      );
    }
    this.records.set(attachmentId, cloneRecord(record));
  }

  async removeRecord(attachmentId: string): Promise<void> {
    this.removeRecordCalls.push(attachmentId);
    this.records.delete(attachmentId);
  }
}

function bytes(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}

function source(vaultPath: string, sourceNotePath?: string): AttachmentSource {
  return {
    kind: "vault",
    vaultId: "vault-test",
    vaultPath,
    ...(sourceNotePath === undefined ? {} : { sourceNotePath }),
  };
}

function configureInspector(): void {
  const digests = new Map<string, string>();
  mockInspectLocalImage.mockImplementation(async (input, declaredMediaType) => {
    const key = Array.from(new Uint8Array(input)).join(",");
    let contentDigest = digests.get(key);
    if (!contentDigest) {
      contentDigest = `${(digests.size + 1).toString(16).padStart(2, "0")}${"a".repeat(62)}`;
      digests.set(key, contentDigest);
    }
    return {
      mediaType: "image/png",
      extension: "png",
      byteLength: input.byteLength,
      contentDigest,
    };
  });
}

function cloneRecord(record: PersistentAttachmentRef): PersistentAttachmentRef {
  return {
    ...record,
    source: { ...record.source },
  };
}

describe("attachmentStore", () => {
  beforeEach(() => {
    mockInspectLocalImage.mockReset();
    configureInspector();
  });

  describe("AttachmentStore", () => {
    describe("put()", () => {
      it("writes one opaque reference and deduplicates identical bytes without merging source metadata", async () => {
        const io = new FaultInjectionAttachmentIO();
        const ids = ["att-first", "att-second"];
        const store = new AttachmentStore(io, {
          createReferenceId: () => ids.shift() ?? "att-unexpected",
        });
        const image = bytes(1, 2, 3, 4);

        const first = await store.put({
          bytes: image,
          mediaType: "image/png",
          source: source("assets/diagram.png", "Notes/reading.md"),
        });
        const second = await store.put({
          bytes: image,
          mediaType: "image/png",
          source: source("Notes2/assets/diagram.png", "Notes2/other.md"),
        });

        expect(first.attachmentId).toBe("att-first");
        expect(second.attachmentId).toBe("att-second");
        expect(first.attachmentId).not.toBe(second.attachmentId);
        expect(first.contentDigest).toBe(second.contentDigest);
        expect(first.source).toEqual(source("assets/diagram.png", "Notes/reading.md"));
        expect(second.source).toEqual(source("Notes2/assets/diagram.png", "Notes2/other.md"));
        expect(io.blobs.size).toBe(1);
        expect(io.records.size).toBe(2);
        expect(JSON.stringify(first)).not.toContain("data:");
        expect(JSON.stringify(first)).not.toContain("/Users/");
        expect(io.writeBlobCalls).toHaveLength(1);
        expect(io.writeRecordCalls).toEqual(["att-first", "att-second"]);
      });

      it("does not overwrite a reference when the opaque id factory collides", async () => {
        const io = new FaultInjectionAttachmentIO();
        const store = new AttachmentStore(io, {
          createReferenceId: () => "att-same",
          maxReferenceIdAttempts: 2,
        });
        const first = await store.put({ bytes: bytes(1, 2), source: source("a.png") });

        await expect(
          store.put({ bytes: bytes(1, 2), source: source("b.png") })
        ).rejects.toMatchObject({
          code: "reference-id-collision",
        });
        expect(io.records.size).toBe(1);
        expect(io.records.get(first.attachmentId)).toMatchObject({
          source: source("a.png"),
        });
      });

      it("rejects a payload above the configured limit before any I/O", async () => {
        const io = new FaultInjectionAttachmentIO();
        const store = new AttachmentStore(io, { maxBytes: 3 });

        await expect(
          store.put({ bytes: bytes(1, 2, 3, 4), source: source("large.png") })
        ).rejects.toEqual(
          expect.objectContaining<Partial<AttachmentStoreError>>({ code: "size-limit" })
        );
        expect(mockInspectLocalImage).not.toHaveBeenCalled();
        expect(io.writeBlobCalls).toEqual([]);
        expect(io.writeRecordCalls).toEqual([]);
      });

      it("keeps an orphaned blob when the reference write fails so automatic GC cannot delete shared bytes", async () => {
        const io = new FaultInjectionAttachmentIO();
        io.failRecordWrite = true;
        const store = new AttachmentStore(io, {
          createReferenceId: () => "att-orphan",
        });

        await expect(
          store.put({ bytes: bytes(5, 6), source: source("orphan.png") })
        ).rejects.toThrow("injected record write failure");
        expect(io.blobs.size).toBe(1);
        expect(io.records.size).toBe(0);
      });

      it("does not report success when an atomic blob write does not leave a readable blob", async () => {
        const io = new FaultInjectionAttachmentIO();
        io.failBlobWrite = true;
        const store = new AttachmentStore(io, {
          createReferenceId: () => "att-no-blob",
        });

        await expect(
          store.put({ bytes: bytes(7, 8), source: source("missing.png") })
        ).rejects.toThrow("injected blob write failure");
        expect(io.records.size).toBe(0);
      });

      it("rejects absolute or path-like source metadata without writing it", async () => {
        const io = new FaultInjectionAttachmentIO();
        const store = new AttachmentStore(io);

        await expect(
          store.put({ bytes: bytes(1), source: source("/Users/alice/private.png") })
        ).rejects.toMatchObject({ code: "invalid-input" });
        await expect(
          store.put({
            bytes: bytes(1),
            source: { kind: "external", displayName: "/tmp/private.png" },
          })
        ).rejects.toMatchObject({ code: "invalid-input" });
        expect(io.writeBlobCalls).toEqual([]);
        expect(io.writeRecordCalls).toEqual([]);
      });

      it("rejects missing, blank, control-bearing, or oversized vault identities", async () => {
        const invalidVaultIds = ["", " ", "vault\nname", "v".repeat(257)];

        for (const vaultId of invalidVaultIds) {
          const io = new FaultInjectionAttachmentIO();
          const store = new AttachmentStore(io);

          await expect(
            store.put({
              bytes: bytes(1),
              source: { kind: "vault", vaultId, vaultPath: "assets/image.png" },
            })
          ).rejects.toMatchObject({ code: "invalid-input" });
          expect(io.writeBlobCalls).toEqual([]);
          expect(io.writeRecordCalls).toEqual([]);
        }
      });
    });

    describe("read()", () => {
      it("returns a defensive copy and verifies the content digest and metadata", async () => {
        const io = new FaultInjectionAttachmentIO();
        const store = new AttachmentStore(io, { createReferenceId: () => "att-read" });
        const ref = await store.put({ bytes: bytes(9, 10), source: source("read.png") });

        const returned = await store.read(ref.attachmentId);
        expect(returned).not.toBeNull();
        new Uint8Array(returned!)[0] = 99;
        const reread = await store.read(ref.attachmentId);
        expect(reread).not.toBeNull();
        expect(Array.from(new Uint8Array(reread!))).toEqual([9, 10]);
      });

      it("rejects a changed blob, a missing blob, and an unsupported record version", async () => {
        const io = new FaultInjectionAttachmentIO();
        const store = new AttachmentStore(io, { createReferenceId: () => "att-integrity" });
        const ref = await store.put({ bytes: bytes(11, 12), source: source("integrity.png") });

        io.blobs.set(ref.contentDigest, bytes(13, 14));
        await expect(store.read(ref.attachmentId)).rejects.toMatchObject({ code: "integrity" });

        io.blobs.delete(ref.contentDigest);
        await expect(store.read(ref.attachmentId)).rejects.toMatchObject({ code: "integrity" });

        io.records.set(ref.attachmentId, { ...ref, schemaVersion: 999 });
        await expect(store.read(ref.attachmentId)).rejects.toMatchObject({
          code: "invalid-record",
        });
      });

      it("returns null for an absent reference without probing a blob", async () => {
        const io = new FaultInjectionAttachmentIO();
        const store = new AttachmentStore(io);

        await expect(store.read("att-missing")).resolves.toBeNull();
        expect(io.blobs.size).toBe(0);
      });

      it("rejects malformed reference ids before reaching the injected I/O", async () => {
        const io = new FaultInjectionAttachmentIO();
        const store = new AttachmentStore(io);

        await expect(store.read("../outside")).rejects.toMatchObject({
          code: "invalid-reference-id",
        });
        expect(io.records.size).toBe(0);
      });
    });

    describe("inspectMetadata()", () => {
      it("validates the authoritative record without touching blob storage", async () => {
        const io = new FaultInjectionAttachmentIO();
        const store = new AttachmentStore(io, { createReferenceId: () => "att-metadata" });
        const reference = await store.put({ bytes: bytes(17, 18), source: source("metadata.png") });
        io.blobExistsCalls.length = 0;
        io.readBlobCalls.length = 0;

        await expect(store.inspectMetadata(reference.attachmentId)).resolves.toEqual(reference);
        expect(io.blobExistsCalls).toEqual([]);
        expect(io.readBlobCalls).toEqual([]);
      });
    });

    describe("remove()", () => {
      it("removes one reference while preserving the shared blob and sibling reference", async () => {
        const io = new FaultInjectionAttachmentIO();
        const ids = ["att-remove", "att-sibling"];
        const store = new AttachmentStore(io, {
          createReferenceId: () => ids.shift() ?? "att-unexpected",
        });
        const image = bytes(15, 16);
        const removed = await store.put({ bytes: image, source: source("removed.png") });
        const sibling = await store.put({ bytes: image, source: source("sibling.png") });

        await store.remove(removed.attachmentId);

        expect(io.records.has(removed.attachmentId)).toBe(false);
        expect(io.records.has(sibling.attachmentId)).toBe(true);
        expect(io.blobs.has(sibling.contentDigest)).toBe(true);
        await expect(store.read(sibling.attachmentId)).resolves.toEqual(image);
        expect(io.removeRecordCalls).toEqual([removed.attachmentId]);
      });

      it("is idempotent for an absent reference and never removes a blob", async () => {
        const io = new FaultInjectionAttachmentIO();
        const store = new AttachmentStore(io);

        await expect(store.remove("att-absent")).resolves.toBeUndefined();
        expect(io.removeRecordCalls).toEqual([]);
        expect(io.blobs.size).toBe(0);
      });

      it("can remove a targeted corrupted record without trusting its metadata", async () => {
        const io = new FaultInjectionAttachmentIO();
        io.records.set("att-corrupt", {
          schemaVersion: ATTACHMENT_SCHEMA_VERSION + 1,
          attachmentId: "att-corrupt",
        });
        const store = new AttachmentStore(io);

        await store.remove("att-corrupt");
        expect(io.records.has("att-corrupt")).toBe(false);
        expect(io.removeRecordCalls).toEqual(["att-corrupt"]);
      });
    });
  });
});
