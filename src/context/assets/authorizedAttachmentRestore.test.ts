import { webcrypto } from "crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { AttachmentStore } from "./attachmentStore";
import {
  ATTACHMENT_REFERENCE_ENVELOPE_SCHEMA_VERSION,
  AuthorizedAttachmentRestoreError,
  createAuthorizedAttachmentRestore,
  type AttachmentRestoreEnvelope,
} from "./authorizedAttachmentRestore";
import {
  ATTACHMENT_SCHEMA_VERSION,
  AttachmentStoreError,
  type AttachmentSource,
  type BinaryAttachmentIO,
  type PersistentAttachmentRef,
} from "./attachmentStoreTypes";
import { createNodeAttachmentIO } from "./nodeAttachmentIO";

const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c,
  0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64, 0xf8, 0x0f, 0x00,
  0x01, 0x05, 0x01, 0x01, 0x27, 0x18, 0xe3, 0x66, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

beforeAll(() => {
  if (!window.crypto?.subtle) {
    Object.defineProperty(window, "crypto", { configurable: true, value: webcrypto });
  }
});

class MemoryAttachmentIO implements BinaryAttachmentIO {
  readonly blobs = new Map<string, ArrayBuffer>();
  readonly records = new Map<string, unknown>();
  readonly blobExistsCalls: string[] = [];
  readonly readBlobCalls: string[] = [];
  readonly readRecordCalls: string[] = [];
  onReadBlob?: () => void;

  async blobExists(contentDigest: string): Promise<boolean> {
    this.blobExistsCalls.push(contentDigest);
    return this.blobs.has(contentDigest);
  }

  async readBlob(contentDigest: string): Promise<ArrayBuffer | null> {
    this.readBlobCalls.push(contentDigest);
    this.onReadBlob?.();
    return this.blobs.get(contentDigest)?.slice(0) ?? null;
  }

  async writeBlobAtomic(contentDigest: string, bytes: ArrayBuffer): Promise<void> {
    if (!this.blobs.has(contentDigest)) this.blobs.set(contentDigest, bytes.slice(0));
  }

  async readRecord(attachmentId: string): Promise<unknown> {
    this.readRecordCalls.push(attachmentId);
    const record = this.records.get(attachmentId);
    if (record === undefined) return null;
    if (!isRecord(record) || !isRecord(record.source)) return record;
    return { ...record, source: { ...record.source } };
  }

  async writeRecordAtomic(attachmentId: string, record: PersistentAttachmentRef): Promise<void> {
    if (this.records.has(attachmentId)) {
      throw new AttachmentStoreError("reference-id-collision", "injected record collision");
    }
    this.records.set(attachmentId, {
      ...record,
      source: { ...record.source },
    });
  }

  async removeRecord(attachmentId: string): Promise<void> {
    this.records.delete(attachmentId);
  }
}

function imageBytes(): ArrayBuffer {
  return TINY_PNG.slice().buffer;
}

function vaultSource(vaultId: string, vaultPath = "assets/diagram.png"): AttachmentSource {
  return { kind: "vault", vaultId, vaultPath, sourceNotePath: "Notes/reading.md" };
}

function envelope(vaultId: string, attachmentId: string): AttachmentRestoreEnvelope {
  return {
    schemaVersion: ATTACHMENT_REFERENCE_ENVELOPE_SCHEMA_VERSION,
    vaultId,
    attachmentId,
  };
}

function externalSource(): AttachmentSource {
  return { kind: "external", displayName: "fixture.png" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("authorizedAttachmentRestore", () => {
  let parent: string;
  let root: string;

  beforeEach(async () => {
    parent = await fs.mkdtemp(path.join(os.tmpdir(), "authorized-attachment-"));
    root = path.join(parent, "approved-root");
    await fs.mkdir(root);
  });

  afterEach(async () => {
    await fs.rm(parent, { recursive: true, force: true });
  });

  describe("createAuthorizedAttachmentRestore()", () => {
    it("restores through a reloaded disk store only after authorizing the authoritative path", async () => {
      const firstStore = new AttachmentStore(createNodeAttachmentIO(root), {
        createReferenceId: () => "att-reload-restore",
      });
      const reference = await firstStore.put({
        bytes: imageBytes(),
        source: vaultSource("vault-a"),
      });
      const authorizeVaultPath = jest.fn().mockResolvedValue(true);
      const restore = createAuthorizedAttachmentRestore({
        store: new AttachmentStore(createNodeAttachmentIO(root)),
        currentVaultId: "vault-a",
        authorizeVaultPath,
      });

      await expect(restore.restore(envelope("vault-a", reference.attachmentId))).resolves.toEqual(
        imageBytes()
      );
      expect(authorizeVaultPath).toHaveBeenNthCalledWith(1, "assets/diagram.png");
      expect(authorizeVaultPath).toHaveBeenNthCalledWith(2, "assets/diagram.png");
    });

    it("does not read a same-path record from another vault", async () => {
      const io = new MemoryAttachmentIO();
      const store = new AttachmentStore(io, { createReferenceId: () => "att-cross-vault" });
      const reference = await store.put({
        bytes: imageBytes(),
        source: vaultSource("vault-a", "same/path.png"),
      });
      io.blobExistsCalls.length = 0;
      io.readBlobCalls.length = 0;
      const authorizeVaultPath = jest.fn().mockResolvedValue(true);
      const restore = createAuthorizedAttachmentRestore({
        store,
        currentVaultId: "vault-b",
        authorizeVaultPath,
      });

      await expect(
        restore.restore(envelope("vault-b", reference.attachmentId))
      ).rejects.toMatchObject({ code: "foreign-vault" });
      expect(io.readBlobCalls).toEqual([]);
      expect(authorizeVaultPath).not.toHaveBeenCalled();
    });

    it("rejects a forged envelope whose id names a foreign authoritative record", async () => {
      const io = new MemoryAttachmentIO();
      const store = new AttachmentStore(io, { createReferenceId: () => "att-forged" });
      const reference = await store.put({ bytes: imageBytes(), source: vaultSource("vault-b") });
      io.readBlobCalls.length = 0;
      const authorizeVaultPath = jest.fn().mockResolvedValue(true);
      const restore = createAuthorizedAttachmentRestore({
        store,
        currentVaultId: "vault-a",
        authorizeVaultPath,
      });

      await expect(
        restore.restore(envelope("vault-a", reference.attachmentId))
      ).rejects.toMatchObject({ code: "foreign-vault" });
      expect(io.readBlobCalls).toEqual([]);
      expect(authorizeVaultPath).not.toHaveBeenCalled();
    });

    it("rejects missing records and unsupported external records before authorization or blob access", async () => {
      const missingIO = new MemoryAttachmentIO();
      const missingRestore = createAuthorizedAttachmentRestore({
        store: new AttachmentStore(missingIO),
        currentVaultId: "vault-a",
        authorizeVaultPath: jest.fn().mockResolvedValue(true),
      });

      await expect(
        missingRestore.restore(envelope("vault-a", "att-missing"))
      ).rejects.toMatchObject({ code: "not-found" });
      expect(missingIO.readBlobCalls).toEqual([]);

      const externalIO = new MemoryAttachmentIO();
      const externalStore = new AttachmentStore(externalIO, {
        createReferenceId: () => "att-external",
      });
      const external = await externalStore.put({ bytes: imageBytes(), source: externalSource() });
      externalIO.readBlobCalls.length = 0;
      const authorizeVaultPath = jest.fn().mockResolvedValue(true);
      const externalRestore = createAuthorizedAttachmentRestore({
        store: externalStore,
        currentVaultId: "vault-a",
        authorizeVaultPath,
      });

      await expect(
        externalRestore.restore(envelope("vault-a", external.attachmentId))
      ).rejects.toMatchObject({ code: "unsupported-source" });
      expect(externalIO.readBlobCalls).toEqual([]);
      expect(authorizeVaultPath).not.toHaveBeenCalled();
    });

    it("does not read a blob when the initial authorization is false or throws", async () => {
      for (const authorizeVaultPath of [
        jest.fn().mockResolvedValue(false),
        jest.fn().mockRejectedValue(new Error("/private/vault/secret")),
      ]) {
        const io = new MemoryAttachmentIO();
        const store = new AttachmentStore(io, { createReferenceId: () => "att-denied" });
        const reference = await store.put({ bytes: imageBytes(), source: vaultSource("vault-a") });
        io.readBlobCalls.length = 0;
        const restore = createAuthorizedAttachmentRestore({
          store,
          currentVaultId: "vault-a",
          authorizeVaultPath,
        });

        const attempt = restore.restore(envelope("vault-a", reference.attachmentId));
        await expect(attempt).rejects.toMatchObject({ code: "authorization-denied" });
        await expect(attempt).rejects.not.toThrow("/private/vault/secret");
        expect(io.readBlobCalls).toEqual([]);
      }
    });

    it("discards bytes when authorization is revoked during the asynchronous read", async () => {
      const io = new MemoryAttachmentIO();
      const store = new AttachmentStore(io, { createReferenceId: () => "att-revoked" });
      const reference = await store.put({ bytes: imageBytes(), source: vaultSource("vault-a") });
      io.readBlobCalls.length = 0;
      const events: string[] = [];
      io.onReadBlob = () => events.push("blob-read");
      const authorizeVaultPath = jest.fn().mockImplementation(async (vaultPath: string) => {
        events.push(`authorize:${vaultPath}`);
        return events.filter((event) => event.startsWith("authorize:")).length === 1;
      });
      const restore = createAuthorizedAttachmentRestore({
        store,
        currentVaultId: "vault-a",
        authorizeVaultPath,
      });

      await expect(
        restore.restore(envelope("vault-a", reference.attachmentId))
      ).rejects.toMatchObject({ code: "authorization-denied" });
      expect(events).toEqual([
        "authorize:assets/diagram.png",
        "blob-read",
        "authorize:assets/diagram.png",
      ]);
      expect(io.readBlobCalls).toHaveLength(1);
    });

    it("fails closed for a legacy record missing vault identity and for corrupt bytes", async () => {
      const legacyIO = new MemoryAttachmentIO();
      legacyIO.records.set("att-legacy", {
        schemaVersion: ATTACHMENT_SCHEMA_VERSION,
        attachmentId: "att-legacy",
        mediaType: "image/png",
        extension: "png",
        byteLength: TINY_PNG.byteLength,
        contentDigest: "a".repeat(64),
        source: { kind: "vault", vaultPath: "assets/legacy.png" },
      });
      const legacyAuthorize = jest.fn().mockResolvedValue(true);
      const legacyRestore = createAuthorizedAttachmentRestore({
        store: new AttachmentStore(legacyIO),
        currentVaultId: "vault-a",
        authorizeVaultPath: legacyAuthorize,
      });

      await expect(legacyRestore.restore(envelope("vault-a", "att-legacy"))).rejects.toMatchObject({
        code: "invalid-record",
      });
      expect(legacyIO.readBlobCalls).toEqual([]);
      expect(legacyAuthorize).not.toHaveBeenCalled();

      const corruptIO = new MemoryAttachmentIO();
      const corruptStore = new AttachmentStore(corruptIO, {
        createReferenceId: () => "att-corrupt-restore",
      });
      const reference = await corruptStore.put({
        bytes: imageBytes(),
        source: vaultSource("vault-a"),
      });
      corruptIO.blobs.set(reference.contentDigest, new Uint8Array([1, 2, 3]).buffer);
      corruptIO.readBlobCalls.length = 0;
      const corruptRestore = createAuthorizedAttachmentRestore({
        store: corruptStore,
        currentVaultId: "vault-a",
        authorizeVaultPath: jest.fn().mockResolvedValue(true),
      });

      await expect(
        corruptRestore.restore(envelope("vault-a", reference.attachmentId))
      ).rejects.toMatchObject({ code: "integrity" });
      expect(corruptIO.readBlobCalls).toHaveLength(1);
    });

    it("rejects malformed envelopes without consulting the store", async () => {
      const io = new MemoryAttachmentIO();
      const restore = createAuthorizedAttachmentRestore({
        store: new AttachmentStore(io),
        currentVaultId: "vault-a",
        authorizeVaultPath: jest.fn().mockResolvedValue(true),
      });
      const malformedEnvelopes: readonly unknown[] = [
        { schemaVersion: 2, vaultId: "vault-a", attachmentId: "att-one" },
        { schemaVersion: 1, vaultId: " ", attachmentId: "att-one" },
        { schemaVersion: 1, vaultId: "vault-a", attachmentId: "../outside" },
      ];

      for (const malformed of malformedEnvelopes) {
        await expect(restore.restore(malformed)).rejects.toBeInstanceOf(
          AuthorizedAttachmentRestoreError
        );
        await expect(restore.restore(malformed)).rejects.toMatchObject({ code: "invalid-request" });
      }
      expect(io.readRecordCalls).toEqual([]);
      expect(io.readBlobCalls).toEqual([]);
    });
  });
});
