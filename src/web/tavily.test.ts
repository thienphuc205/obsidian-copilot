import { requestUrl } from "obsidian";
import { createTavilyWebProvider } from "@/web/tavily";
import { WebProviderError, type WebProviderTransport } from "@/web/types";

jest.mock("obsidian", () => ({ requestUrl: jest.fn() }));
const API_KEY = "tvly-private-fixture";
const validItem = {
  url: "https://example.com/docs",
  title: " Docs ",
  content: " Text ",
  published_date: "2026-09-10",
};

describe("tavily", () => {
  describe("createTavilyWebProvider()", () => {
    let transport: jest.MockedFunction<WebProviderTransport>;
    beforeEach(() => {
      jest.clearAllMocks();
      transport = jest.fn().mockResolvedValue({ status: 200, json: { results: [validItem] } });
    });

    it.each(["", "tiny", "tvly-key\nsecret", "tvly-key secret", "x".repeat(257)])(
      "rejects invalid credentials %p before network access",
      (apiKey) => {
        expect(() => createTavilyWebProvider({ apiKey, transport })).toThrow(WebProviderError);
        expect(transport).not.toHaveBeenCalled();
      }
    );

    it("rejects an invalid configuration without a request", () => {
      expect(() => createTavilyWebProvider(null as never)).toThrow(WebProviderError);
      expect(() => createTavilyWebProvider({ apiKey: API_KEY, transport: 1 as never })).toThrow(
        WebProviderError
      );
    });

    it("issues only the explicit bounded search and normalizes source metadata", async () => {
      const provider = createTavilyWebProvider({ apiKey: API_KEY, transport });
      expect(transport).not.toHaveBeenCalled();
      const result = await provider.search(" public docs ", { limit: 2 });
      expect(result).toEqual({
        kind: "web_search",
        content: "Docs\nhttps://example.com/docs\nText",
        sources: [
          { title: "Docs", url: validItem.url, snippet: "Text", publishedAt: "2026-09-10" },
        ],
        citations: [validItem.url],
      });
      const req = transport.mock.calls[0][0];
      expect(req.url).toBe("https://api.tavily.com/search");
      expect(req.headers).toEqual({ Authorization: `Bearer ${API_KEY}` });
      expect(JSON.parse(req.body)).toEqual({
        query: "public docs",
        max_results: 2,
        search_depth: "basic",
        topic: "general",
        auto_parameters: false,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_published_date: true,
      });
      expect(req.body).not.toContain(API_KEY);
    });

    it.each([
      ["", undefined],
      ["x".repeat(513), undefined],
      ["query", 0],
      ["query", 11],
      ["query", 1.5],
    ])("rejects invalid query/limit before a request: %p %p", async (query, limit) => {
      await expect(
        createTavilyWebProvider({ apiKey: API_KEY, transport }).search(query, { limit })
      ).rejects.toMatchObject({ code: "invalid_query" });
      expect(transport).not.toHaveBeenCalled();
    });

    it("deduplicates, filters private citations, and bounds source fields and count", async () => {
      transport.mockResolvedValue({
        status: 200,
        json: {
          results: [
            { url: "http://127.0.0.1/secret" },
            validItem,
            validItem,
            ...Array.from({ length: 12 }, (_, i) => ({
              url: `https://example.com/${i}`,
              title: "t".repeat(1000),
              content: "s".repeat(10000),
            })),
          ],
        },
      });
      const result = await createTavilyWebProvider({ apiKey: API_KEY, transport }).search("docs", {
        limit: 10,
      });
      expect(result.sources).toHaveLength(10);
      expect(new Set(result.citations).size).toBe(10);
      expect(result.sources[1].title).toHaveLength(300);
      expect(result.sources[1].snippet).toHaveLength(2000);
      expect(result.content).not.toContain("127.0.0.1");
    });

    it("returns stable empty source collections for searches with no results", async () => {
      transport.mockResolvedValue({ status: 200, json: { results: [] } });
      const provider = createTavilyWebProvider({ apiKey: API_KEY, transport });
      const first = await provider.search("none");
      const second = await provider.search("none");
      expect(first.sources).toBe(second.sources);
      expect(first.citations).toBe(second.citations);
      expect(first.content).toBe("");
    });

    it.each([
      null,
      "{broken",
      { results: {} },
      { results: Array(1001).fill(validItem) },
      { results: [{ url: "file:///private" }] },
    ])("rejects malformed or unusable search output", async (json) => {
      transport.mockResolvedValue({ status: 200, json });
      await expect(
        createTavilyWebProvider({ apiKey: API_KEY, transport }).search("docs")
      ).rejects.toMatchObject({ code: "malformed_response" });
    });

    it("fetches one URL through Extract and bounds the page with its citation", async () => {
      transport.mockResolvedValue({
        status: 200,
        json: {
          results: [{ url: validItem.url, raw_content: "a".repeat(100001) }],
          failed_results: [],
        },
      });
      const result = await createTavilyWebProvider({ apiKey: API_KEY, transport }).fetch(
        validItem.url
      );
      expect(result.content).toHaveLength(100000);
      expect(result).toMatchObject({
        kind: "web_fetch",
        url: validItem.url,
        truncated: true,
        sources: [{ title: "example.com", url: validItem.url }],
        citations: [validItem.url],
      });
      expect(transport.mock.calls[0][0].url).toBe("https://api.tavily.com/extract");
      expect(JSON.parse(transport.mock.calls[0][0].body)).toEqual({
        urls: [validItem.url],
        extract_depth: "basic",
        format: "markdown",
        include_images: false,
        include_favicon: false,
        timeout: 20,
      });
    });

    it.each([
      "file:///vault/note.md",
      "http://localhost",
      "http://10.0.0.1",
      "https://user:password@example.com",
    ])("rejects a nonpublic fetch URL %p before calling Tavily", async (url) => {
      await expect(
        createTavilyWebProvider({ apiKey: API_KEY, transport }).fetch(url)
      ).rejects.toMatchObject({ code: "invalid_url" });
      expect(transport).not.toHaveBeenCalled();
    });

    it.each([
      { results: [], failed_results: [{ error: API_KEY }] },
      { results: [{ url: "https://other.example.com", raw_content: "wrong page" }] },
      { results: [{ url: validItem.url, raw_content: "" }] },
      { results: [{ url: validItem.url, raw_content: "page" }], failed_results: "broken" },
    ])(
      "fails closed on partial or mismatched extraction without exposing provider errors",
      async (json) => {
        transport.mockResolvedValue({ status: 200, json });
        await expect(
          createTavilyWebProvider({ apiKey: API_KEY, transport }).fetch(validItem.url)
        ).rejects.toMatchObject({
          code: "malformed_response",
          message: "Tavily returned an invalid response.",
        });
      }
    );

    it.each([
      [401, "unauthorized"],
      [429, "rate_limited"],
      [432, "quota_exceeded"],
      [433, "quota_exceeded"],
      [500, "server"],
    ])(
      "maps HTTP %p to a sanitized %p error (https://docs.tavily.com/documentation/api-reference/endpoint/search)",
      async (status, code) => {
        transport.mockResolvedValue({ status, json: { detail: API_KEY } });
        const result = createTavilyWebProvider({ apiKey: API_KEY, transport }).search("docs");
        await expect(result).rejects.toMatchObject({ code, status });
        await expect(result).rejects.not.toThrow(API_KEY);
      }
    );

    it("sanitizes transport rejection and never retries", async () => {
      transport.mockRejectedValue(new Error(API_KEY));
      await expect(
        createTavilyWebProvider({ apiKey: API_KEY, transport }).search("docs")
      ).rejects.toMatchObject({ code: "network", message: "Could not reach Tavily." });
      expect(transport).toHaveBeenCalledTimes(1);
    });

    it("honors pre-cancellation without sending a request", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        createTavilyWebProvider({ apiKey: API_KEY, transport }).search("docs", {
          signal: controller.signal,
        })
      ).rejects.toMatchObject({ code: "timeout" });
      expect(transport).not.toHaveBeenCalled();
    });

    it("rejects oversized raw data before reading JSON", async () => {
      const readJson = jest.fn(() => ({ results: [] }));
      transport.mockResolvedValue({
        status: 200,
        text: "界".repeat(200000),
        get json() {
          return readJson();
        },
      });
      await expect(
        createTavilyWebProvider({ apiKey: API_KEY, transport }).search("docs")
      ).rejects.toMatchObject({ code: "malformed_response" });
      expect(readJson).not.toHaveBeenCalled();
    });

    it("probes only on explicit invocation using the default Obsidian transport", async () => {
      jest.mocked(requestUrl).mockResolvedValue({
        status: 200,
        headers: {},
        text: '{"results":[]}',
        arrayBuffer: new ArrayBuffer(0),
        json: { results: [] },
      });
      const provider = createTavilyWebProvider({ apiKey: API_KEY });
      expect(requestUrl).not.toHaveBeenCalled();
      await provider.testConnection();
      expect(requestUrl).toHaveBeenCalledTimes(1);
      const sent = jest.mocked(requestUrl).mock.calls[0][0];
      if (typeof sent === "string") throw new Error("Expected POST request parameters");
      expect(JSON.parse(sent.body as string)).toMatchObject({
        query: "Tavily",
        max_results: 1,
      });
    });
  });
});
