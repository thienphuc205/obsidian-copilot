import { webcrypto } from "crypto";

import type { TFile } from "obsidian";

import { mockTFile } from "@/__tests__/mockObsidian";

import { AttachmentStore } from "./attachmentStore";
import {
  AttachmentStoreError,
  type BinaryAttachmentIO,
  type PersistentAttachmentRef,
} from "./attachmentStoreTypes";
import { createLocalImageIngestion, type LocalImageIngestionInput } from "./localImageIngestion";
import type { LocalImageReader } from "./assetTypes";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeAll(() => {
  if (!window.crypto?.subtle) {
    Object.defineProperty(window, "crypto", { configurable: true, value: webcrypto });
  }
});

class MemoryAttachmentIO implements BinaryAttachmentIO {
  readonly blobs = new Map<string, ArrayBuffer>();
  readonly records = new Map<string, PersistentAttachmentRef>();
  readonly writeBlobCalls: string[] = [];
  readonly writeRecordCalls: string[] = [];
  failNextRecordWrite = false;

  async blobExists(contentDigest: string): Promise<boolean> {
    return this.blobs.has(contentDigest);
  }

  async readBlob(contentDigest: string): Promise<ArrayBuffer | null> {
    return this.blobs.get(contentDigest)?.slice(0) ?? null;
  }

  async writeBlobAtomic(contentDigest: string, bytes: ArrayBuffer): Promise<void> {
    this.writeBlobCalls.push(contentDigest);
    if (!this.blobs.has(contentDigest)) {
      this.blobs.set(contentDigest, bytes.slice(0));
    }
  }

  async readRecord(attachmentId: string): Promise<unknown> {
    const record = this.records.get(attachmentId);
    return record ? { ...record, source: { ...record.source } } : null;
  }

  async writeRecordAtomic(attachmentId: string, record: PersistentAttachmentRef): Promise<void> {
    this.writeRecordCalls.push(attachmentId);
    if (this.failNextRecordWrite) {
      this.failNextRecordWrite = false;
      throw new Error("injected reference write failure");
    }
    if (this.records.has(attachmentId)) {
      throw new AttachmentStoreError("reference-id-collision", "injected reference collision");
    }
    this.records.set(attachmentId, { ...record, source: { ...record.source } });
  }

  async removeRecord(attachmentId: string): Promise<void> {
    this.records.delete(attachmentId);
  }
}

interface ReaderEntry {
  readonly reference: string;
  readonly sourceNotePath?: string;
  readonly file: TFile;
  readonly bytes: ArrayBuffer;
}

interface ReaderHarness {
  readonly reader: LocalImageReader;
  readonly resolveLink: jest.Mock;
  readonly readBinary: jest.Mock;
  readonly authorizeResolvedFile: jest.Mock;
}

function createReader(entries: readonly ReaderEntry[]): ReaderHarness {
  const byReference = new Map(
    entries.map((entry) => [JSON.stringify([entry.reference, entry.sourceNotePath]), entry])
  );
  const bytesByPath = new Map(entries.map((entry) => [entry.file.path, entry.bytes]));
  const resolveLink = jest.fn(
    (reference: string, sourceNotePath?: string) =>
      byReference.get(JSON.stringify([reference, sourceNotePath]))?.file ?? null
  );
  const readBinary = jest.fn(async (file: TFile) => {
    const bytes = bytesByPath.get(file.path);
    if (!bytes) throw new Error("fixture file is missing");
    return bytes.slice(0);
  });
  const authorizeResolvedFile = jest.fn().mockReturnValue(true);
  return {
    reader: {
      resolveLink,
      readBinary,
      authorizeResolvedFile,
      getVaultId: () => "vault-test",
    },
    resolveLink,
    readBinary,
    authorizeResolvedFile,
  };
}

function imageEntry(
  reference: string,
  sourceNotePath: string | undefined,
  vaultPath: string,
  bytes = PNG_BYTES.buffer
): ReaderEntry {
  return {
    reference,
    sourceNotePath,
    file: mockTFile({
      path: vaultPath,
      extension: "png",
      stat: { size: bytes.byteLength, mtime: 1, ctime: 1 },
    }),
    bytes,
  };
}

function storeWithIds(io: MemoryAttachmentIO, ids: string[]): AttachmentStore {
  return new AttachmentStore(io, {
    createReferenceId: () => ids.shift() ?? "att-unexpected",
  });
}

describe("localImageIngestion", () => {
  describe("createLocalImageIngestion()", () => {
    it("composes the real resolver and store for note embeds, deduplicating bytes while retaining each source", async () => {
      const inputs: LocalImageIngestionInput[] = [
        { reference: "../assets/one.png", sourceNotePath: "Notes/one.md" },
        { reference: "../assets/two.png", sourceNotePath: "Notes/two.md" },
      ];
      const harness = createReader([
        imageEntry(inputs[0].reference, inputs[0].sourceNotePath, "assets/one.png"),
        imageEntry(inputs[1].reference, inputs[1].sourceNotePath, "assets/two.png"),
      ]);
      const io = new MemoryAttachmentIO();
      const service = createLocalImageIngestion({
        reader: harness.reader,
        store: storeWithIds(io, ["att-one", "att-two"]),
      });

      const result = await service.ingest(inputs);

      expect(result.persisted.map((attachment) => attachment.attachmentId)).toEqual([
        "att-one",
        "att-two",
      ]);
      expect(result.persistedCount).toBe(2);
      expect(result.persistedBytes).toBe(PNG_BYTES.byteLength * 2);
      expect(io.blobs.size).toBe(1);
      expect(io.records.size).toBe(2);
      expect(result.items[0]).toMatchObject({
        status: "persisted",
        reference: inputs[0].reference,
        source: {
          vaultId: "vault-test",
          vaultPath: "assets/one.png",
          sourceNotePath: "Notes/one.md",
        },
        attachment: {
          attachmentId: "att-one",
          source: {
            kind: "vault",
            vaultId: "vault-test",
            vaultPath: "assets/one.png",
            sourceNotePath: "Notes/one.md",
          },
        },
      });
      expect(result.items[1]).toMatchObject({
        status: "persisted",
        source: { vaultPath: "assets/two.png", sourceNotePath: "Notes/two.md" },
        attachment: {
          attachmentId: "att-two",
          source: {
            kind: "vault",
            vaultId: "vault-test",
            vaultPath: "assets/two.png",
            sourceNotePath: "Notes/two.md",
          },
        },
      });
      expect(result.items[0]).not.toHaveProperty("bytes");
      expect(harness.authorizeResolvedFile).toHaveBeenCalledTimes(2);
    });

    it("keeps external or unresolved inputs out of storage with zero writes", async () => {
      const harness = createReader([]);
      const io = new MemoryAttachmentIO();
      const service = createLocalImageIngestion({
        reader: harness.reader,
        store: storeWithIds(io, ["att-never"]),
      });

      const result = await service.ingest([
        { reference: "https://example.com/image.png", sourceNotePath: "Notes/read.md" },
        { reference: "assets/missing.png", sourceNotePath: "Notes/read.md" },
      ]);

      expect(result.items).toEqual([
        { status: "rejected", reason: "external", reference: "https://example.com/image.png" },
        { status: "rejected", reason: "not-found", reference: "assets/missing.png" },
      ]);
      expect(harness.resolveLink).toHaveBeenCalledTimes(1);
      expect(io.writeBlobCalls).toEqual([]);
      expect(io.writeRecordCalls).toEqual([]);
    });

    it("enforces the aggregate count budget before resolving later inputs", async () => {
      const first = imageEntry("assets/one.png", undefined, "assets/one.png");
      const second = imageEntry("assets/two.png", undefined, "assets/two.png");
      const harness = createReader([first, second]);
      const io = new MemoryAttachmentIO();
      const service = createLocalImageIngestion({
        reader: harness.reader,
        store: storeWithIds(io, ["att-one"]),
        maxCount: 1,
      });

      const result = await service.ingest([
        { reference: first.reference },
        { reference: second.reference },
      ]);

      expect(result.items).toMatchObject([
        { status: "persisted", attachment: { attachmentId: "att-one" } },
        { status: "skipped", reason: "budget-exceeded", reference: second.reference },
      ]);
      expect(result.persistedCount).toBe(1);
      expect(harness.resolveLink).toHaveBeenCalledTimes(1);
      expect(io.writeRecordCalls).toEqual(["att-one"]);
    });

    it("enforces the aggregate byte budget after resolution and before the next store write", async () => {
      const first = imageEntry("assets/one.png", undefined, "assets/one.png");
      const second = imageEntry("assets/two.png", undefined, "assets/two.png");
      const harness = createReader([first, second]);
      const io = new MemoryAttachmentIO();
      const service = createLocalImageIngestion({
        reader: harness.reader,
        store: storeWithIds(io, ["att-one"]),
        maxBytes: PNG_BYTES.byteLength,
      });

      const result = await service.ingest([
        { reference: first.reference },
        { reference: second.reference },
      ]);

      expect(result.items).toMatchObject([
        { status: "persisted", attachment: { attachmentId: "att-one" } },
        {
          status: "skipped",
          reason: "budget-exceeded",
          reference: second.reference,
          source: { vaultPath: "assets/two.png" },
        },
      ]);
      expect(result.persistedBytes).toBe(PNG_BYTES.byteLength);
      expect(harness.readBinary).toHaveBeenCalledTimes(2);
      expect(io.writeRecordCalls).toEqual(["att-one"]);
    });

    it("reports a sanitized storage failure while retaining earlier success and the store's orphan policy", async () => {
      const first = imageEntry("assets/one.png", undefined, "assets/one.png");
      const second = imageEntry("assets/two.png", undefined, "assets/two.png");
      const harness = createReader([first, second]);
      const io = new MemoryAttachmentIO();
      io.failNextRecordWrite = true;
      const service = createLocalImageIngestion({
        reader: harness.reader,
        store: storeWithIds(io, ["att-failed", "att-success"]),
      });

      const result = await service.ingest([
        { reference: first.reference },
        { reference: second.reference },
      ]);

      const failed = result.items[0];
      expect(failed).toMatchObject({
        status: "failed",
        reason: "storage-failed",
        reference: first.reference,
        source: {
          vaultId: "vault-test",
          vaultPath: "assets/one.png",
          kind: "image",
          mediaType: "image/png",
          byteLength: PNG_BYTES.byteLength,
        },
      });
      if (failed?.status === "failed") {
        expect(failed.source.contentDigest).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(failed).not.toHaveProperty("message");
      expect(result.items[1]).toMatchObject({
        status: "persisted",
        attachment: { attachmentId: "att-success" },
      });
      expect(result.persistedCount).toBe(1);
      expect(io.blobs.size).toBe(1);
      expect(io.records.size).toBe(1);
      expect(io.writeRecordCalls).toEqual(["att-failed", "att-success"]);
    });

    it("bounds explicit input handling and rejects invalid configuration before any storage", async () => {
      const harness = createReader([]);
      const io = new MemoryAttachmentIO();

      expect(() =>
        createLocalImageIngestion({
          reader: harness.reader,
          store: storeWithIds(io, ["att-never"]),
          maxCount: 0,
        })
      ).toThrow("Local image ingestion count limit is invalid");

      const service = createLocalImageIngestion({
        reader: harness.reader,
        store: storeWithIds(io, ["att-never"]),
      });
      await expect(
        service.ingest(Array.from({ length: 65 }, () => ({ reference: "assets/image.png" })))
      ).rejects.toThrow("Local image ingestion input count is invalid");
      expect(io.writeBlobCalls).toEqual([]);
      expect(io.writeRecordCalls).toEqual([]);
    });
  });
});
