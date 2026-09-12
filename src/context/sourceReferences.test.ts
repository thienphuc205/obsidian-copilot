import {
  isSafeSourceUrl,
  resolveSourceInspectorTarget,
  type SourceReference,
} from "./sourceReferences";

const source = (overrides: Partial<SourceReference> = {}): SourceReference => ({
  title: "Paper",
  path: "Research/paper.md",
  score: 0.9,
  ...overrides,
});

describe("isSafeSourceUrl", () => {
  it.each(["https://example.com/docs", "http://example.com/docs?q=1#part"])(
    "accepts public browser URLs %s",
    (url) => {
      expect(isSafeSourceUrl(url)).toBe(true);
    }
  );

  it.each(["javascript:alert(1)", "file:///tmp/secret", "https://user:pass@example.com"])(
    "rejects unsafe browser URL %s",
    (url) => {
      expect(isSafeSourceUrl(url)).toBe(false);
    }
  );
});

describe("resolveSourceInspectorTarget", () => {
  it("keeps legacy URL-in-path sources compatible and classifies them as web", () => {
    expect(resolveSourceInspectorTarget(source({ path: "https://example.com/paper" }))).toEqual({
      kind: "web",
      url: "https://example.com/paper",
    });
  });

  it("preserves page, line, and safe anchor metadata for vault sources", () => {
    expect(
      resolveSourceInspectorTarget(
        source({ path: "Research/paper.md#Methods", page: 3, line: 12, endLine: 18 })
      )
    ).toEqual({
      kind: "vault",
      path: "Research/paper.md",
      anchor: "#Methods",
      page: 3,
      line: 12,
      endLine: 18,
    });
  });

  it("rejects traversal, malformed page metadata, and reversed line ranges", () => {
    expect(resolveSourceInspectorTarget(source({ path: "../secret.md" }))).toBeNull();
    expect(resolveSourceInspectorTarget(source({ page: 0 }))).toBeNull();
    expect(resolveSourceInspectorTarget(source({ line: 8, endLine: 3 }))).toBeNull();
    expect(
      resolveSourceInspectorTarget(source({ kind: "web", url: "javascript:alert(1)" }))
    ).toBeNull();
  });
});
