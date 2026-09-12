import type { SourceReference } from "@/context/sourceReferences";
import {
  CHAT_SOURCE_REF_SCHEMA_VERSION,
  MAX_CHAT_SOURCE_REFS,
  MAX_CHAT_SOURCE_REFS_SERIALIZED_BYTES,
  escapeChatSourceMarkerLiteral,
  normalizeChatSourceRefs,
  parseChatSourceMarkerLiteral,
  parseChatSourceRefMarker,
  serializeChatSourceRefs,
} from "./chatSourceRefs";

const source = (overrides: Partial<SourceReference> = {}): SourceReference => ({
  title: "Docs",
  path: "https://example.test/docs",
  score: 0.9,
  kind: "web",
  url: "https://example.test/docs",
  ...overrides,
});

describe("chat source reference envelope", () => {
  describe("normalizeChatSourceRefs()", () => {
    it("keeps bounded web metadata, deduplicates by URL, and freezes the result", () => {
      const normalized = normalizeChatSourceRefs([
        source({ title: "Second", url: "https://example.test/second" }),
        source({ title: "First", url: "https://example.test/first" }),
        source({
          title: "Duplicate",
          url: "https://example.test/second",
          path: "/private/should-not-persist",
          score: 0,
          explanation: { secret: "not persisted" },
          snippet: "Excerpt",
          publishedAt: "2026-09-11",
        }),
      ]);

      expect(normalized).toEqual([
        { title: "Second", url: "https://example.test/second" },
        { title: "First", url: "https://example.test/first" },
      ]);
      expect(Object.isFrozen(normalized)).toBe(true);
      expect(Object.isFrozen(normalized[0])).toBe(true);
    });

    it("retains bounded optional metadata while rejecting invalid envelopes as a whole", () => {
      const normalized = normalizeChatSourceRefs([
        source({
          snippet: "A useful excerpt",
          publishedAt: "2026-09-11T12:00:00Z",
        }),
      ]);

      expect(normalized).toEqual([
        {
          title: "Docs",
          url: "https://example.test/docs",
          snippet: "A useful excerpt",
          publishedAt: "2026-09-11T12:00:00Z",
        },
      ]);
      expect(normalizeChatSourceRefs(null)).toEqual([]);
      expect(normalizeChatSourceRefs([])).toEqual([]);
      expect(
        normalizeChatSourceRefs(
          Array.from({ length: MAX_CHAT_SOURCE_REFS + 1 }, (_, index) =>
            source({ url: `https://example.test/${index}` })
          )
        )
      ).toEqual([]);
      expect(normalizeChatSourceRefs([source({ url: "javascript:alert(1)" })])).toEqual([]);
      expect(normalizeChatSourceRefs([source({ url: "http://localhost/private" })])).toEqual([]);
      expect(normalizeChatSourceRefs([source({ url: "http://192.168.1.10/private" })])).toEqual([]);
      expect(
        normalizeChatSourceRefs([source({ url: "https://user:pass@example.test/private" })])
      ).toEqual([]);
    });

    it("rejects a serialized payload larger than the conservative UTF-8 bound", () => {
      const normalized = normalizeChatSourceRefs(
        Array.from({ length: MAX_CHAT_SOURCE_REFS }, (_, index) =>
          source({
            url: `https://example.test/${index}`,
            snippet: "é".repeat(400),
          })
        )
      );

      expect(normalized).toEqual([]);
    });
  });

  describe("serializeChatSourceRefs()", () => {
    it("serializes only metadata and round-trips the exact normalized envelope", () => {
      const marker = serializeChatSourceRefs([
        source({
          title: "Research",
          snippet: "Short excerpt",
          publishedAt: "2026-09-11",
          path: "/vault/private.md",
          score: 0.42,
          explanation: { secret: "must not be written" },
        }),
      ]);

      expect(marker).toContain(
        `copilot-agent-source-refs:v${CHAT_SOURCE_REF_SCHEMA_VERSION};metadata`
      );
      expect(marker).toContain('"title":"Research"');
      expect(marker).toContain('"url":"https://example.test/docs"');
      expect(marker).not.toContain("/vault/private.md");
      expect(marker).not.toContain('"score"');
      expect(marker).not.toContain('"explanation"');
      expect(marker).not.toContain("must not be written");
      expect(parseChatSourceRefMarker(marker)).toEqual([
        {
          title: "Research",
          url: "https://example.test/docs",
          snippet: "Short excerpt",
          publishedAt: "2026-09-11",
        },
      ]);
      expect(serializeChatSourceRefs([])).toBeNull();
      expect(serializeChatSourceRefs({ sources: [source()] })).toBeNull();
    });
  });

  describe("parseChatSourceRefMarker()", () => {
    it("fails closed for malformed, oversized, unsafe, unknown-version, and spoofed payloads", () => {
      const malformed = [
        null,
        "ordinary text",
        "<!-- copilot-agent-source-refs:v1;metadata {not-json} -->",
        '<!-- copilot-agent-source-refs:v2;metadata [{"title":"Docs","url":"https://example.test"}] -->',
        '<!-- copilot-agent-source-refs:v1;metadata [{"title":"Docs","url":"javascript:alert(1)"}] -->',
        '<!-- copilot-agent-source-refs:v1;metadata [{"title":"Docs","url":"https://user:pass@example.test"}] -->',
        '<!-- copilot-agent-source-refs:v1;metadata [{"title":"Docs","url":"ftp://example.test"}] -->',
        '<!-- copilot-agent-source-refs:v1;metadata [{"title":"Docs","url":"http://localhost/private"}] -->',
        '<!-- copilot-agent-source-refs:v1;metadata [{"title":"Docs","url":"http://10.0.0.1/private"}] -->',
        '<!-- copilot-agent-source-refs:v1;metadata [{"title":"Docs","url":"https://example.test","path":"/secret"}] -->',
        '<!-- copilot-agent-source-refs:v1;metadata [{"title":"Docs","url":"https://example.test","score":1}] -->',
        '<!-- copilot-agent-source-refs:v1;metadata [{"title":"Docs","url":"https://example.test","explanation":{"secret":"x"}}] -->',
      ];

      for (const candidate of malformed) {
        expect(parseChatSourceRefMarker(candidate)).toBeNull();
      }

      const oversized = `<!-- copilot-agent-source-refs:v1;metadata ${JSON.stringify([
        { title: "Docs", url: "https://example.test", snippet: "é".repeat(5000) },
      ])} -->`;
      expect(parseChatSourceRefMarker(oversized)).toBeNull();
      expect(MAX_CHAT_SOURCE_REFS_SERIALIZED_BYTES).toBe(4096);
    });

    it("leaves marker-like ordinary text inert", () => {
      const markerLike =
        "A note mentioning <!-- copilot-agent-source-refs:v1;metadata [not-json] --> in prose";

      expect(parseChatSourceRefMarker(markerLike)).toBeNull();
    });
  });

  describe("escapeChatSourceMarkerLiteral() and parseChatSourceMarkerLiteral()", () => {
    it("round-trips a user message that exactly matches a valid source marker", () => {
      const marker = serializeChatSourceRefs([source()]);
      const literal = escapeChatSourceMarkerLiteral(marker!);

      expect(literal).not.toBe(marker);
      expect(literal).toContain("copilot-agent-source-refs:v1;literal");
      expect(parseChatSourceMarkerLiteral(literal)).toBe(marker);
      expect(escapeChatSourceMarkerLiteral("ordinary text")).toBe("ordinary text");
      expect(parseChatSourceMarkerLiteral("ordinary text")).toBeNull();
    });

    it("does not decode malformed literal frames", () => {
      expect(
        parseChatSourceMarkerLiteral(
          '<!-- copilot-agent-source-refs:v1;literal "not-a-valid-source-marker" -->'
        )
      ).toBeNull();
      expect(
        parseChatSourceMarkerLiteral(
          '<!-- copilot-agent-source-refs:v1;literal {"text":"spoofed"} -->'
        )
      ).toBeNull();
    });
  });
});
