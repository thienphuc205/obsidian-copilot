import { webcrypto } from "crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ATTACHMENT_SCHEMA_VERSION,
  AttachmentStoreError,
  type AttachmentSource,
  type PersistentAttachmentRef,
} from "./attachmentStoreTypes";
import { AttachmentStore } from "./attachmentStore";
import { inspectLocalImage } from "./imageValidation";
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

function imageBytes(): ArrayBuffer {
  return TINY_PNG.slice().buffer;
}

function source(vaultPath: string, sourceNotePath?: string): AttachmentSource {
  return {
    kind: "vault",
    vaultId: "vault-test",
    vaultPath,
    ...(sourceNotePath === undefined ? {} : { sourceNotePath }),
  };
}

function record(attachmentId: string): PersistentAttachmentRef {
  return {
    schemaVersion: ATTACHMENT_SCHEMA_VERSION,
    attachmentId,
    mediaType: "image/png",
    extension: "png",
    byteLength: 1,
    contentDigest: "a".repeat(64),
    source: { kind: "external", displayName: "fixture.png" },
  };
}

function attachmentRoot(root: string): string {
  return path.join(root, "attachments-v1");
}

function blobsDirectory(root: string): string {
  return path.join(attachmentRoot(root), "blobs");
}

function recordsDirectory(root: string): string {
  return path.join(attachmentRoot(root), "records");
}

async function entries(directory: string): Promise<string[]> {
  return (await fs.readdir(directory)).sort();
}

async function readStoredRecord(
  root: string,
  attachmentId: string
): Promise<PersistentAttachmentRef> {
  const json = await fs.readFile(path.join(recordsDirectory(root), `${attachmentId}.json`), "utf8");
  return JSON.parse(json) as PersistentAttachmentRef;
}

describe("nodeAttachmentIO", () => {
  let parent: string;
  let root: string;

  beforeEach(async () => {
    parent = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-io-"));
    root = path.join(parent, "approved-root");
    await fs.mkdir(root);
  });

  afterEach(async () => {
    await fs.rm(parent, { recursive: true, force: true });
  });

  describe("createNodeAttachmentIO()", () => {
    it("composes with the real inspector and reloads through a new store instance", async () => {
      const inspection = await inspectLocalImage(imageBytes(), "image/png");
      const firstStore = new AttachmentStore(createNodeAttachmentIO(root), {
        createReferenceId: () => "att-reload",
      });

      const reference = await firstStore.put({
        bytes: imageBytes(),
        declaredMediaType: "image/png",
        source: source("Images/diagram.png", "Notes/reading.md"),
      });

      expect(reference.contentDigest).toBe(inspection.contentDigest);
      expect(await entries(root)).toEqual(["attachments-v1"]);
      expect(await entries(blobsDirectory(root))).toEqual([reference.contentDigest]);
      expect(await entries(recordsDirectory(root))).toEqual(["att-reload.json"]);

      const reloadedStore = new AttachmentStore(createNodeAttachmentIO(root));
      const bytes = await reloadedStore.read("att-reload");
      expect(bytes).not.toBeNull();
      expect(Array.from(new Uint8Array(bytes!))).toEqual(Array.from(TINY_PNG));
    });

    it("keeps an existing record observable when its sibling blob directory is missing", async () => {
      const io = createNodeAttachmentIO(root);
      const store = new AttachmentStore(io, {
        createReferenceId: () => "att-missing-blob-directory",
      });
      const reference = await store.put({
        bytes: imageBytes(),
        source: source("missing-blob-directory.png"),
      });

      await fs.rm(blobsDirectory(root), { recursive: true, force: true });

      await expect(store.read(reference.attachmentId)).rejects.toMatchObject({ code: "integrity" });
      await expect(store.remove(reference.attachmentId)).resolves.toBeUndefined();
      await expect(io.readRecord(reference.attachmentId)).resolves.toBeNull();
    });

    it("deduplicates identical bytes while preserving both sources and the shared blob after targeted removal", async () => {
      const io = createNodeAttachmentIO(root);
      const ids = ["att-first", "att-second"];
      const store = new AttachmentStore(io, {
        createReferenceId: () => ids.shift() ?? "att-unexpected",
      });

      const first = await store.put({
        bytes: imageBytes(),
        source: source("Notes/assets/diagram.png", "Notes/first.md"),
      });
      const second = await store.put({
        bytes: imageBytes(),
        source: source("Archive/assets/diagram.png", "Archive/second.md"),
      });

      expect(first.contentDigest).toBe(second.contentDigest);
      expect(await entries(blobsDirectory(root))).toEqual([first.contentDigest]);
      expect(await entries(recordsDirectory(root))).toEqual(["att-first.json", "att-second.json"]);
      expect((await readStoredRecord(root, first.attachmentId)).source).toEqual(
        source("Notes/assets/diagram.png", "Notes/first.md")
      );
      expect((await readStoredRecord(root, second.attachmentId)).source).toEqual(
        source("Archive/assets/diagram.png", "Archive/second.md")
      );

      await store.remove(first.attachmentId);

      expect(await entries(recordsDirectory(root))).toEqual(["att-second.json"]);
      expect(await entries(blobsDirectory(root))).toEqual([second.contentDigest]);
      await expect(store.read(second.attachmentId)).resolves.toEqual(imageBytes());
      expect(JSON.stringify(second)).not.toContain("data:");
      expect(JSON.stringify(second)).not.toContain(root);
    });

    it("keeps concurrent unique puts in separate records while installing one shared blob", async () => {
      const io = createNodeAttachmentIO(root);
      const firstStore = new AttachmentStore(io, {
        createReferenceId: () => "att-concurrent-first",
      });
      const secondStore = new AttachmentStore(io, {
        createReferenceId: () => "att-concurrent-second",
      });

      const [first, second] = await Promise.all([
        firstStore.put({ bytes: imageBytes(), source: source("first.png") }),
        secondStore.put({ bytes: imageBytes(), source: source("second.png") }),
      ]);

      expect(new Set([first.attachmentId, second.attachmentId]).size).toBe(2);
      expect(await entries(blobsDirectory(root))).toHaveLength(1);
      expect(await entries(recordsDirectory(root))).toHaveLength(2);
    });

    it("rejects a concurrent same-id record without clobbering the winning source", async () => {
      const io = createNodeAttachmentIO(root);
      const firstStore = new AttachmentStore(io, {
        createReferenceId: () => "att-collision",
        maxReferenceIdAttempts: 3,
      });
      const secondStore = new AttachmentStore(io, {
        createReferenceId: () => "att-collision",
        maxReferenceIdAttempts: 3,
      });

      const results = await Promise.allSettled([
        firstStore.put({ bytes: imageBytes(), source: source("winner.png") }),
        secondStore.put({ bytes: imageBytes(), source: source("loser.png") }),
      ]);
      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<PersistentAttachmentRef> =>
          result.status === "fulfilled"
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(AttachmentStoreError);
      expect(rejected[0]?.reason).toMatchObject({ code: "reference-id-collision" });
      expect(await entries(recordsDirectory(root))).toEqual(["att-collision.json"]);
      const persisted = await readStoredRecord(root, "att-collision");
      expect(persisted.source.kind).toBe("vault");
      if (persisted.source.kind === "vault") {
        expect(["winner.png", "loser.png"]).toContain(persisted.source.vaultPath);
      }
    });

    it("rejects changed records, malformed records, and changed blobs without returning bytes", async () => {
      const io = createNodeAttachmentIO(root);
      const store = new AttachmentStore(io, {
        createReferenceId: () => "att-corrupt",
      });
      const reference = await store.put({ bytes: imageBytes(), source: source("corrupt.png") });
      const recordPath = path.join(recordsDirectory(root), "att-corrupt.json");
      const blobPath = path.join(blobsDirectory(root), reference.contentDigest);

      await fs.writeFile(recordPath, JSON.stringify({ ...reference, schemaVersion: 999 }));
      await expect(store.read(reference.attachmentId)).rejects.toMatchObject({
        code: "invalid-record",
      });

      await fs.writeFile(recordPath, "{");
      await expect(io.readRecord(reference.attachmentId)).rejects.toMatchObject({
        code: "corrupt-record",
      });

      await fs.writeFile(recordPath, JSON.stringify(reference));
      const changed = TINY_PNG.slice();
      changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 0xff;
      await fs.writeFile(blobPath, changed);
      await expect(store.read(reference.attachmentId)).rejects.toMatchObject({ code: "integrity" });
    });

    it("bounds blob and record reads before allocating untrusted file sizes", async () => {
      const io = createNodeAttachmentIO(root, {
        maxBlobBytes: TINY_PNG.byteLength,
        maxRecordBytes: 32,
      });
      await fs.mkdir(blobsDirectory(root), { recursive: true });
      await fs.mkdir(recordsDirectory(root), { recursive: true });
      const digest = "b".repeat(64);

      await fs.writeFile(
        path.join(blobsDirectory(root), digest),
        new Uint8Array(TINY_PNG.length + 1)
      );
      await expect(io.readBlob(digest)).rejects.toMatchObject({ code: "size-limit" });

      await fs.writeFile(
        path.join(recordsDirectory(root), "att-large.json"),
        JSON.stringify({ attachmentId: "att-large", padding: "x".repeat(64) })
      );
      await expect(io.readRecord("att-large")).rejects.toMatchObject({ code: "size-limit" });
    });

    it("rejects key traversal, root symlinks, and symlinked attachment targets", async () => {
      const io = createNodeAttachmentIO(root);
      const digest = "c".repeat(64);

      await expect(io.readBlob("../" + digest)).rejects.toMatchObject({ code: "invalid-key" });
      await expect(io.readRecord("../escape")).rejects.toMatchObject({ code: "invalid-key" });

      await fs.mkdir(blobsDirectory(root), { recursive: true });
      await fs.mkdir(recordsDirectory(root), { recursive: true });
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-outside-"));
      try {
        const outsideBlob = path.join(outside, "outside.blob");
        const outsideRecord = path.join(outside, "outside.json");
        await fs.writeFile(outsideBlob, TINY_PNG);
        await fs.writeFile(outsideRecord, JSON.stringify(record("att-link")));
        await fs.symlink(outsideBlob, path.join(blobsDirectory(root), digest));
        await fs.symlink(outsideRecord, path.join(recordsDirectory(root), "att-link.json"));

        await expect(io.readBlob(digest)).rejects.toMatchObject({ code: "root-confinement" });
        await expect(io.readRecord("att-link")).rejects.toMatchObject({
          code: "root-confinement",
        });

        await fs.rm(blobsDirectory(root), { recursive: true, force: true });
        await fs.symlink(outside, blobsDirectory(root));
        await expect(io.readBlob(digest)).rejects.toMatchObject({
          code: "root-confinement",
        });
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }

      const linkedRoot = path.join(parent, "approved-root-link");
      await fs.symlink(root, linkedRoot);
      await expect(
        createNodeAttachmentIO(linkedRoot).readRecord("att-missing")
      ).rejects.toMatchObject({
        code: "invalid-root",
      });
    });

    it("does not expose approved-root paths through adapter errors", async () => {
      const missingRoot = path.join(parent, "missing-root");
      const error = await createNodeAttachmentIO(missingRoot)
        .readBlob("e".repeat(64))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ code: "invalid-root" });
      expect(String(error)).not.toContain(missingRoot);
      expect(JSON.stringify(error)).not.toContain(missingRoot);
    });

    it("installs atomically, leaves no temporary files, and never overwrites a record", async () => {
      const io = createNodeAttachmentIO(root);
      const first = record("att-atomic");

      await io.writeBlobAtomic(first.contentDigest, imageBytes());
      await io.writeRecordAtomic(first.attachmentId, first);
      await expect(
        io.writeRecordAtomic(first.attachmentId, {
          ...first,
          source: { kind: "external", displayName: "other.png" },
        })
      ).rejects.toMatchObject({
        code: "reference-id-collision",
      });

      expect(await io.readRecord(first.attachmentId)).toEqual(first);
      expect(
        (await entries(blobsDirectory(root))).every(
          (entry) => !entry.startsWith(".attachment-tmp-")
        )
      ).toBe(true);
      expect(
        (await entries(recordsDirectory(root))).every(
          (entry) => !entry.startsWith(".attachment-tmp-")
        )
      ).toBe(true);
    });

    it("fails closed when the versioned namespace is replaced by a file", async () => {
      const namespace = attachmentRoot(root);
      await fs.writeFile(namespace, "not a directory");
      const io = createNodeAttachmentIO(root);

      await expect(io.writeBlobAtomic("d".repeat(64), imageBytes())).rejects.toMatchObject({
        code: "root-confinement",
      });
      expect(await entries(root)).toEqual(["attachments-v1"]);
    });
  });
});
