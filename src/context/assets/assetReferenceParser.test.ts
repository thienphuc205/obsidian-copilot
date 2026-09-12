import { parseEmbeddedAssetReferences } from "@/context/assets/assetReferenceParser";

describe("assetReferenceParser", () => {
  describe("parseEmbeddedAssetReferences()", () => {
    it("uses the existing Markdown destination parser for spaces, angle brackets, titles, and balanced parentheses", () => {
      const references = parseEmbeddedAssetReferences(
        '![first](../assets/diagram image.png "caption")\n![second](<assets/chart (draft).webp>)'
      );

      expect(references).toEqual([
        { reference: "../assets/diagram image.png", syntax: "markdown" },
        { reference: "assets/chart (draft).webp", syntax: "markdown" },
      ]);
    });

    it("extracts wiki destinations without including the display alias", () => {
      const references = parseEmbeddedAssetReferences(
        "![[assets/diagram image.png|A caption]]\n![[nested/photo.webp]]"
      );

      expect(references).toEqual([
        { reference: "assets/diagram image.png", syntax: "wiki" },
        { reference: "nested/photo.webp", syntax: "wiki" },
      ]);
    });

    it("keeps remote destinations for the resolver to reject and ignores malformed or oversized wiki entries", () => {
      const oversized = `![[${"a".repeat(4097)}.png]]`;

      expect(
        parseEmbeddedAssetReferences(`![remote](https://example.com/image.png) ${oversized}`)
      ).toEqual([{ reference: "https://example.com/image.png", syntax: "markdown" }]);
      expect(parseEmbeddedAssetReferences("![[unterminated.png]")).toEqual([]);
    });

    it("caps the number of returned references", () => {
      const note = Array.from({ length: 160 }, (_, index) => `![[image-${index}.png]]`).join(" ");

      expect(parseEmbeddedAssetReferences(note)).toHaveLength(128);
    });
  });
});
