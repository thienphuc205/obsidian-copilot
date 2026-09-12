import {
  IMAGE_DESCRIPTION_MAX_ENTRIES,
  IMAGE_DESCRIPTION_SCHEMA_VERSION,
  ImageDescriptionStore,
  ImageDescriptionStoreError,
  normalizeImageDescriptionEntry,
  type ImageDescriptionEntry,
  type ImageDescriptionIO,
  type PutImageDescriptionInput,
} from "./imageDescriptionStore";

class MemoryImageDescriptionIO implements ImageDescriptionIO {
  contents: string | null = null;
  writeCalls = 0;
  failWrite = false;

  async readFile(): Promise<string | null> {
    return this.contents;
  }

  async writeFile(contents: string): Promise<void> {
    this.writeCalls += 1;
    if (this.failWrite) throw new Error("injected write failure");
    this.contents = contents;
  }
}

function digestOf(value: number): string {
  return value.toString(16).padStart(64, "0");
}

function entryAt(
  digest: string,
  updatedAt: string,
  description = "a description"
): PutImageDescriptionInput {
  return { digest, description, updatedAt };
}

function iso(minute: number): string {
  return `2026-01-01T00:${minute.toString().padStart(2, "0")}:00.000Z`;
}

describe("imageDescriptionStore", () => {
  describe("normalizeImageDescriptionEntry()", () => {
    it("accepts a fully populated entry and returns it frozen", () => {
      const entry = normalizeImageDescriptionEntry({
        digest: digestOf(1),
        description: "described",
        vaultPath: "assets/diagram.png",
        model: "gpt-4o",
        updatedAt: iso(0),
      });

      expect(entry).toEqual({
        digest: digestOf(1),
        description: "described",
        vaultPath: "assets/diagram.png",
        model: "gpt-4o",
        updatedAt: iso(0),
      });
      expect(Object.isFrozen(entry)).toBe(true);
    });

    it("rejects digests that are not 64 lowercase hex characters", () => {
      for (const digest of ["AB".repeat(32), digestOf(1).slice(1), 42, undefined]) {
        expect(
          normalizeImageDescriptionEntry({ digest, description: "d", updatedAt: iso(0) })
        ).toBeNull();
      }
    });

    it("rejects fields beyond their bounds", () => {
      const base = { digest: digestOf(1), updatedAt: iso(0) };
      expect(normalizeImageDescriptionEntry({ ...base, description: "x".repeat(2001) })).toBeNull();
      expect(
        normalizeImageDescriptionEntry({ ...base, description: "d", vaultPath: "x".repeat(1025) })
      ).toBeNull();
      expect(
        normalizeImageDescriptionEntry({ ...base, description: "d", model: "x".repeat(129) })
      ).toBeNull();
      expect(
        normalizeImageDescriptionEntry({ ...base, description: "d", updatedAt: "x".repeat(129) })
      ).toBeNull();
      expect(
        normalizeImageDescriptionEntry({ ...base, description: "d", updatedAt: "not-a-date" })
      ).toBeNull();
      expect(normalizeImageDescriptionEntry({ ...base, description: "" })).toBeNull();
    });

    it("rejects values that are not plain objects", () => {
      expect(normalizeImageDescriptionEntry(null)).toBeNull();
      expect(normalizeImageDescriptionEntry([digestOf(1)])).toBeNull();
      expect(normalizeImageDescriptionEntry("entry")).toBeNull();
    });
  });

  describe("ImageDescriptionStore()", () => {
    let io: MemoryImageDescriptionIO;

    beforeEach(() => {
      io = new MemoryImageDescriptionIO();
    });

    describe("loading", () => {
      it("treats a missing file as an empty store", async () => {
        const store = new ImageDescriptionStore(io);

        expect(await store.size()).toBe(0);
        expect(await store.get(digestOf(1))).toBeNull();
      });

      it("treats corrupt JSON as an empty store and recovers on the next put", async () => {
        io.contents = "{not valid json";
        const store = new ImageDescriptionStore(io);

        expect(await store.size()).toBe(0);
        expect(await store.get(digestOf(1))).toBeNull();

        await store.put(entryAt(digestOf(1), iso(0)));
        const envelope = JSON.parse(io.contents ?? "{}") as Record<string, unknown>;
        expect(envelope).toEqual({
          version: IMAGE_DESCRIPTION_SCHEMA_VERSION,
          entries: [expect.objectContaining({ digest: digestOf(1) })],
        });
      });

      it("treats an unknown envelope version as an empty store", async () => {
        io.contents = JSON.stringify({
          version: IMAGE_DESCRIPTION_SCHEMA_VERSION + 1,
          entries: [entryAt(digestOf(1), iso(0))],
        });
        const store = new ImageDescriptionStore(io);

        expect(await store.size()).toBe(0);
      });

      it("drops invalid entries and keeps valid ones when loading", async () => {
        io.contents = JSON.stringify({
          version: IMAGE_DESCRIPTION_SCHEMA_VERSION,
          entries: [
            entryAt(digestOf(1), iso(0)),
            { digest: "nothex", description: "d", updatedAt: iso(0) },
            { digest: digestOf(2), description: "x".repeat(2001), updatedAt: iso(0) },
            entryAt(digestOf(3), iso(0)),
          ],
        });
        const store = new ImageDescriptionStore(io);

        expect(await store.size()).toBe(2);
        expect(await store.get(digestOf(1))).not.toBeNull();
        expect(await store.get(digestOf(3))).not.toBeNull();
        expect(await store.get(digestOf(2))).toBeNull();
      });
    });

    describe("get()", () => {
      it("returns a stored entry after a successful put", async () => {
        const store = new ImageDescriptionStore(io);
        const stored = await store.put({
          digest: digestOf(1),
          description: "a red diagram",
          vaultPath: "assets/diagram.png",
          model: "gpt-4o",
          updatedAt: iso(0),
        });

        expect(await store.get(digestOf(1))).toEqual(stored);
      });

      it("returns null for unknown digests and rejects malformed digest input", async () => {
        const store = new ImageDescriptionStore(io);

        expect(await store.get(digestOf(1))).toBeNull();
        await expect(store.get("NOPE")).rejects.toBeInstanceOf(ImageDescriptionStoreError);
      });
    });

    describe("put()", () => {
      it("persists the versioned envelope with the new entry", async () => {
        const store = new ImageDescriptionStore(io);

        await store.put({
          digest: digestOf(1),
          description: "a red diagram",
          updatedAt: iso(0),
        });

        expect(io.writeCalls).toBe(1);
        const envelope = JSON.parse(io.contents ?? "{}") as Record<string, unknown>;
        expect(envelope.version).toBe(IMAGE_DESCRIPTION_SCHEMA_VERSION);
        expect(envelope.entries).toEqual([
          { digest: digestOf(1), description: "a red diagram", updatedAt: iso(0) },
        ]);
      });

      it("updates an existing digest in place without growing the store", async () => {
        const store = new ImageDescriptionStore(io);
        await store.put({ digest: digestOf(1), description: "old", updatedAt: iso(0) });

        const updated = await store.put({
          digest: digestOf(1),
          description: "new",
          updatedAt: iso(5),
        });

        expect(await store.size()).toBe(1);
        expect(await store.get(digestOf(1))).toEqual(updated);
      });

      it("defaults updatedAt to the current time when omitted", async () => {
        const store = new ImageDescriptionStore(io);
        const before = Date.now();

        const stored = await store.put({ digest: digestOf(1), description: "d" });

        const parsed = Date.parse(stored.updatedAt);
        expect(parsed).toBeGreaterThanOrEqual(before);
        expect(parsed).toBeLessThanOrEqual(Date.now());
      });

      it("evicts the oldest entry when the capacity is reached", async () => {
        const store = new ImageDescriptionStore(io);
        for (let index = 0; index < IMAGE_DESCRIPTION_MAX_ENTRIES; index += 1) {
          await store.put(entryAt(digestOf(index), iso(index % 60)));
        }

        await store.put(entryAt(digestOf(999), iso(59)));

        expect(await store.size()).toBe(IMAGE_DESCRIPTION_MAX_ENTRIES);
        expect(await store.get(digestOf(0))).toBeNull();
        expect(await store.get(digestOf(999))).not.toBeNull();
      });

      it("breaks eviction ties by digest so the outcome is deterministic", async () => {
        const store = new ImageDescriptionStore(io);
        // Two entries share the oldest updatedAt; the lexicographically
        // smaller digest must be the one evicted.
        await store.put(entryAt(digestOf(2), iso(0)));
        await store.put(entryAt(digestOf(1), iso(0)));
        for (let index = 2; index <= IMAGE_DESCRIPTION_MAX_ENTRIES; index += 1) {
          await store.put(entryAt(digestOf(index), iso(index % 60)));
        }

        await store.put(entryAt(digestOf(999), iso(59)));

        expect(await store.get(digestOf(1))).toBeNull();
        expect(await store.get(digestOf(2))).not.toBeNull();
      });

      it("rejects invalid input without touching persistence", async () => {
        const store = new ImageDescriptionStore(io);

        await expect(
          store.put({ digest: "not-a-digest", description: "d" })
        ).rejects.toBeInstanceOf(ImageDescriptionStoreError);
        await expect(
          store.put({ digest: digestOf(1), description: "x".repeat(2001) })
        ).rejects.toBeInstanceOf(ImageDescriptionStoreError);
        expect(io.writeCalls).toBe(0);
        expect(await store.size()).toBe(0);
      });

      it("rolls back the in-memory change and rejects with an io error when persistence fails", async () => {
        const store = new ImageDescriptionStore(io);
        const first = await store.put({
          digest: digestOf(1),
          description: "kept",
          updatedAt: iso(0),
        });
        io.failWrite = true;

        await expect(store.put({ digest: digestOf(2), description: "lost" })).rejects.toMatchObject(
          {
            name: "ImageDescriptionStoreError",
            code: "io",
          }
        );

        io.failWrite = false;
        expect(await store.size()).toBe(1);
        expect(await store.get(digestOf(2))).toBeNull();
        expect(await store.get(digestOf(1))).toEqual(first);
        const persisted = JSON.parse(io.contents ?? "[]") as { entries?: unknown[] };
        expect(persisted.entries).toHaveLength(1);
      });

      it("keeps the previous entry when an in-place update fails to persist", async () => {
        const store = new ImageDescriptionStore(io);
        const first = await store.put({
          digest: digestOf(1),
          description: "kept",
          updatedAt: iso(0),
        });
        io.failWrite = true;

        await expect(
          store.put({ digest: digestOf(1), description: "lost", updatedAt: iso(5) })
        ).rejects.toMatchObject({ code: "io" });

        io.failWrite = false;
        expect(await store.get(digestOf(1))).toEqual(first);
      });
    });

    describe("list()", () => {
      it("returns entries ordered by updatedAt descending", async () => {
        const store = new ImageDescriptionStore(io);
        await store.put(entryAt(digestOf(1), iso(10)));
        await store.put(entryAt(digestOf(2), iso(0)));
        await store.put(entryAt(digestOf(3), iso(5)));

        const listed = await store.list();

        expect(listed.map((entry: ImageDescriptionEntry) => entry.digest)).toEqual([
          digestOf(1),
          digestOf(3),
          digestOf(2),
        ]);
      });

      it("returns a frozen copy that callers cannot mutate through", async () => {
        const store = new ImageDescriptionStore(io);
        await store.put(entryAt(digestOf(1), iso(0)));

        const listed = await store.list();
        expect(Object.isFrozen(listed)).toBe(true);
        expect(Object.isFrozen(listed[0])).toBe(true);

        const mutated = [...listed];
        mutated.pop();
        expect((await store.list()).length).toBe(1);
        expect(listed).toHaveLength(1);
      });

      it("returns the same frozen empty constant when the store is empty", async () => {
        const store = new ImageDescriptionStore(io);

        const first = await store.list();
        expect(first).toEqual([]);
        expect(Object.isFrozen(first)).toBe(true);
        expect(first).toBe(await store.list());
      });
    });

    describe("size()", () => {
      it("counts retained entries after puts", async () => {
        const store = new ImageDescriptionStore(io);
        expect(await store.size()).toBe(0);

        await store.put(entryAt(digestOf(1), iso(0)));
        await store.put(entryAt(digestOf(2), iso(1)));
        await store.put({ digest: digestOf(1), description: "updated", updatedAt: iso(2) });

        expect(await store.size()).toBe(2);
      });
    });
  });
});
