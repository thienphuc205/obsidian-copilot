import { extractAgentWebSourceReferences } from "./agentWebSources";

function textContent(text: string) {
  return [{ type: "content", content: { type: "text", text } }] as const;
}

describe("extractAgentWebSourceReferences", () => {
  it("extracts bounded web metadata only from the plugin-owned bridge", () => {
    const result = extractAgentWebSourceReferences(
      "copilot-web",
      textContent(
        JSON.stringify({
          kind: "web_search",
          content: "answer",
          sources: [
            {
              title: "Docs",
              url: "https://docs.example.test/guide",
              snippet: "A useful excerpt",
              publishedAt: "2026-09-10",
            },
          ],
          citations: ["https://docs.example.test/guide"],
        })
      )
    );

    expect(result).toEqual([
      {
        title: "Docs",
        path: "https://docs.example.test/guide",
        score: 0,
        kind: "web",
        url: "https://docs.example.test/guide",
        snippet: "A useful excerpt",
        publishedAt: "2026-09-10",
      },
    ]);
  });

  it("does not parse lookalike output from another MCP server", () => {
    expect(
      extractAgentWebSourceReferences(
        "other-server",
        textContent(JSON.stringify({ kind: "web_search", sources: [] }))
      )
    ).toBeUndefined();
  });

  it("drops unsafe and malformed sources, deduplicates URLs, and caps output", () => {
    const sources = Array.from({ length: 14 }, (_, index) => ({
      title: `Source ${index}`,
      url: `https://example.test/${index}`,
    }));
    sources.splice(2, 0, { title: "Duplicate", url: "https://example.test/1" });
    sources.push(
      { title: "Unsafe", url: "javascript:alert(1)" },
      { title: "Credentials", url: "https://user:pass@example.test/private" },
      { title: "", url: "https://example.test/empty-title" }
    );

    const result = extractAgentWebSourceReferences(
      "copilot-web",
      textContent(JSON.stringify({ kind: "web_search", sources }))
    );

    expect(result).toHaveLength(10);
    expect(result?.map((source) => source.url)).toEqual([
      "https://example.test/0",
      "https://example.test/1",
      "https://example.test/2",
      "https://example.test/3",
      "https://example.test/4",
      "https://example.test/5",
      "https://example.test/6",
      "https://example.test/7",
      "https://example.test/8",
      "https://example.test/9",
    ]);
  });

  it("keeps a fetch URL when the provider omits its sources array", () => {
    const result = extractAgentWebSourceReferences(
      "copilot-web",
      textContent(
        JSON.stringify({
          kind: "web_fetch",
          url: "https://example.test/page",
          title: "Example page",
          content: "page body",
          citations: [],
          truncated: false,
        })
      )
    );

    expect(result?.[0]).toMatchObject({
      title: "Example page",
      path: "https://example.test/page",
      kind: "web",
      url: "https://example.test/page",
    });
  });

  it("ignores malformed or non-web JSON", () => {
    expect(extractAgentWebSourceReferences("copilot-web", textContent("not json"))).toBeUndefined();
    expect(
      extractAgentWebSourceReferences(
        "copilot-web",
        textContent(
          JSON.stringify({ kind: "other", sources: [{ title: "x", url: "https://x.test" }] })
        )
      )
    ).toBeUndefined();
  });
});
