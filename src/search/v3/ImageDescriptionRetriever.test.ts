import type { ImageDescriptionIO } from "@/context/assets/imageDescriptionStore";
import { IMAGE_DESCRIPTION_SCHEMA_VERSION } from "@/context/assets/imageDescriptionStore";
import type { App } from "obsidian";
import {
  ImageDescriptionRetriever,
  buildImageSearchDocuments,
} from "@/search/v3/ImageDescriptionRetriever";
import { logWarn } from "@/logger";

jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

function digestOf(value: number): string {
  return value.toString(16).padStart(64, "0");
}

function entry(digest: string, description: string, vaultPath?: string): Record<string, unknown> {
  return {
    digest,
    description,
    ...(vaultPath === undefined ? {} : { vaultPath }),
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function envelope(entries: unknown[]): string {
  return JSON.stringify({ version: IMAGE_DESCRIPTION_SCHEMA_VERSION, entries });
}

function ioFor(contents: string | null, failRead = false): ImageDescriptionIO {
  return {
    async readFile(): Promise<string | null> {
      if (failRead) throw new Error("injected read failure");
      return contents;
    },
    async writeFile(): Promise<void> {},
  };
}

function fakeApp(): App {
  return { vault: {} } as unknown as App;
}

const RED_DIAGRAM = entry(digestOf(1), "mountain photo", "photos/red-diagram.png");
const BLUE_SKETCH = entry(digestOf(2), "mountain sketch", "docs/blue.png");

describe("ImageDescriptionRetriever", () => {
  describe("buildImageSearchDocuments()", () => {
    it("ranks docs matching more query terms above weaker matches", () => {
      const docs = buildImageSearchDocuments([RED_DIAGRAM, BLUE_SKETCH], "mountain sketch", {
        minScore: 0,
      });

      expect(docs).toHaveLength(2);
      expect(docs[0].metadata.path as string).toBe("docs/blue.png");
      expect(docs[0].pageContent).toBe("mountain sketch");
      expect(docs[0].metadata.score as number).toBeGreaterThan(docs[1].metadata.score as number);
    });

    it("shapes metadata so citations open the image and label the result", () => {
      const docs = buildImageSearchDocuments([BLUE_SKETCH], "mountain sketch", { minScore: 0 });
      const score = docs[0].metadata.score as number;

      expect(docs[0].metadata).toEqual({
        title: "Image: blue.png",
        path: "docs/blue.png",
        source: "image_description",
        score,
        rerank_score: score,
        includeInContext: true,
        explanation: {
          type: "image",
          digest: digestOf(2),
          description: "mountain sketch",
        },
      });
    });

    it("applies the minScore cutoff to weak matches", () => {
      const withWeak = buildImageSearchDocuments([RED_DIAGRAM, BLUE_SKETCH], "mountain sketch", {
        minScore: 0,
      });
      const scores = withWeak.map((doc) => doc.metadata.score as number).sort((a, b) => b - a);
      const cutoff = (scores[0] + scores[1]) / 2;

      const filtered = buildImageSearchDocuments([RED_DIAGRAM, BLUE_SKETCH], "mountain sketch", {
        minScore: cutoff,
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].metadata.path).toBe("docs/blue.png");
      expect(filtered[0].metadata.score).toBeGreaterThanOrEqual(cutoff);
    });

    it("skips entries without a vaultPath because their citations cannot open", () => {
      const unreachable = entry(digestOf(3), "mountain painting");
      const docs = buildImageSearchDocuments([RED_DIAGRAM, unreachable], "mountain", {
        minScore: 0,
      });

      expect(docs).toHaveLength(1);
      expect(docs[0].metadata.path).toBe("photos/red-diagram.png");
    });

    it("drops untrusted entries that violate store bounds", () => {
      const entries: unknown[] = [
        entry("nothex", "short digest"),
        entry(digestOf(4), ""),
        entry(digestOf(5), "too long: " + "x".repeat(2000)),
        "not an object",
        null,
        entry(digestOf(6), "mountain chart", "docs/chart.png"),
      ];
      const docs = buildImageSearchDocuments(entries, "mountain", { minScore: 0 });

      expect(docs).toHaveLength(1);
      expect(docs[0].metadata.path).toBe("docs/chart.png");
    });

    it("caps results at maxK", () => {
      const entries = [RED_DIAGRAM, BLUE_SKETCH, entry(digestOf(7), "mountain chart", "c.png")];
      const docs = buildImageSearchDocuments(entries, "mountain", { minScore: 0, maxK: 2 });

      expect(docs).toHaveLength(2);
    });

    it("indexes each digest once when untrusted input repeats one", () => {
      const duplicate = entry(digestOf(1), "mountain second copy", "dup.png");
      const docs = buildImageSearchDocuments([RED_DIAGRAM, duplicate], "mountain", {
        minScore: 0,
      });

      expect(docs).toHaveLength(1);
    });

    it("returns an empty result for an empty store or blank query", () => {
      expect(buildImageSearchDocuments([], "mountain")).toEqual([]);
      expect(buildImageSearchDocuments([RED_DIAGRAM], "   ")).toEqual([]);
    });
  });

  describe("ImageDescriptionRetriever", () => {
    describe("getRelevantDocuments()", () => {
      it("loads the store through the injected io and returns matched image docs", async () => {
        const retriever = new ImageDescriptionRetriever(fakeApp(), {
          io: ioFor(envelope([RED_DIAGRAM, entry("not-a-digest", "dropped entry")])),
        });

        const docs = await retriever.getRelevantDocuments("mountain sketch");

        expect(docs).toHaveLength(1);
        expect(docs[0].pageContent).toBe("mountain photo");
        expect(docs[0].metadata.source).toBe("image_description");
        expect(docs[0].metadata.path).toBe("photos/red-diagram.png");
        expect(docs[0].metadata.includeInContext).toBe(true);
      });

      it("treats a missing store file as an empty result", async () => {
        const retriever = new ImageDescriptionRetriever(fakeApp(), { io: ioFor(null) });

        const docs = await retriever.getRelevantDocuments("mountain");

        expect(docs).toEqual([]);
      });

      it("returns empty documents instead of throwing when the store io fails", async () => {
        const retriever = new ImageDescriptionRetriever(fakeApp(), {
          io: ioFor(envelope([RED_DIAGRAM]), true),
        });

        const docs = await retriever.getRelevantDocuments("mountain");

        expect(docs).toEqual([]);
        expect(logWarn).toHaveBeenCalledWith("Image description search failed:", expect.any(Error));
      });
    });
  });
});
