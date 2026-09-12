import { createCustomWebProvider } from "@/web/custom";
import {
  WebProviderError,
  type WebProviderTransport,
  type WebProviderTransportResponse,
} from "@/web/types";

jest.mock("obsidian", () => ({ requestUrl: jest.fn() }));

const API_KEY = "custom-test-key-123456";
const BASE_URL = "https://search.example.test/copilot/";

function response(json: unknown): WebProviderTransportResponse {
  return { status: 200, json };
}

function transportMock(): jest.MockedFunction<WebProviderTransport> {
  return jest.fn() as jest.MockedFunction<WebProviderTransport>;
}

function searchResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "web_search",
    content: "Search result",
    sources: [{ title: "Example", url: "https://example.com/result" }],
    citations: ["https://example.com/result"],
    ...overrides,
  };
}

function fetchResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "web_fetch",
    url: "https://example.com/page",
    title: "Example page",
    content: "Fetched content",
    sources: [{ title: "Example page", url: "https://example.com/page" }],
    citations: ["https://example.com/page"],
    truncated: false,
    ...overrides,
  };
}

async function expectMalformed(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    code: "malformed_response",
    status: null,
    message: "Custom API returned an invalid response.",
    retryable: false,
  });
}

describe("custom", () => {
  describe("createCustomWebProvider()", () => {
    it.each([
      ["an empty API key", ""],
      ["a short API key", "short"],
      ["a key with surrounding whitespace", " custom-key-123 "],
      ["a key with a newline", "custom-key-123\nsecret"],
      ["a key longer than the bound", "x".repeat(257)],
    ])("rejects %s without making a request", (_case, apiKey) => {
      const transport = transportMock();

      expect(() => createCustomWebProvider({ apiKey, baseUrl: BASE_URL, transport })).toThrow(
        WebProviderError
      );
      expect(transport).not.toHaveBeenCalled();
    });

    it.each([
      ["an empty base URL", ""],
      ["a whitespace-only base URL", "   "],
      ["a plain HTTP base URL", "http://search.example.test/api"],
      ["a local HTTPS host", "https://localhost/api"],
      ["a private HTTPS host", "https://192.168.1.10/api"],
      ["a base URL with credentials", "https://user:password@search.example.test/api"],
      ["a base URL with a query", "https://search.example.test/api?token=secret"],
      ["a base URL with a fragment", "https://search.example.test/api#fragment"],
      ["a malformed base URL", "not-a-url"],
    ])("rejects %s before transport", (_case, baseUrl) => {
      const transport = transportMock();

      expect(() => createCustomWebProvider({ apiKey: API_KEY, baseUrl, transport })).toThrow(
        WebProviderError
      );
      expect(transport).not.toHaveBeenCalled();
    });

    it("does not probe the configured API until a provider method is called", () => {
      const transport = transportMock();
      const provider = createCustomWebProvider({ apiKey: API_KEY, baseUrl: BASE_URL, transport });

      expect(typeof provider.search).toBe("function");
      expect(typeof provider.fetch).toBe("function");
      expect(typeof provider.testConnection).toBe("function");
      expect(transport).not.toHaveBeenCalled();
    });

    it("preserves the base path and sends only the bounded search request", async () => {
      const transport = transportMock();
      transport.mockResolvedValue(
        response(
          searchResult({
            content: "  Search result\r\n  ",
            sources: [
              {
                title: "  Example docs  ",
                url: "https://example.com/docs#intro",
                snippet: "  A useful result.  ",
                publishedAt: "2026-09-10",
              },
            ],
            citations: ["https://example.com/docs#intro"],
          })
        )
      );

      const provider = createCustomWebProvider({
        apiKey: API_KEY,
        baseUrl: BASE_URL,
        transport,
      });
      const result = await provider.search("  public docs  ", { limit: 2 });

      expect(result).toEqual({
        kind: "web_search",
        content: "Search result",
        sources: [
          {
            title: "Example docs",
            url: "https://example.com/docs#intro",
            snippet: "A useful result.",
            publishedAt: "2026-09-10",
          },
        ],
        citations: ["https://example.com/docs#intro"],
      });
      const request = transport.mock.calls[0][0];
      expect(request).toMatchObject({
        url: "https://search.example.test/copilot/search",
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}` },
        contentType: "application/json",
        timeoutMs: 30000,
      });
      expect(JSON.parse(request.body)).toEqual({ query: "public docs", limit: 2 });
      expect(request.body).not.toContain(API_KEY);
    });

    it("uses the default search limit and bounds filtered source and citation collections", async () => {
      const transport = transportMock();
      const sources = [
        { title: "Private", url: "http://127.0.0.1/private" },
        { title: "First", url: "https://example.com/0" },
        { title: "Duplicate", url: "https://example.com/0" },
        ...Array.from({ length: 12 }, (_, index) => ({
          title: `Source ${index + 1}`,
          url: `https://example.com/${index + 1}`,
        })),
      ];
      const citations = [
        "file:///private/note.md",
        "https://example.com/citation",
        "https://example.com/citation",
        ...Array.from({ length: 55 }, (_, index) => `https://example.com/citation-${index}`),
      ];
      transport.mockResolvedValue(response(searchResult({ sources, citations })));

      const provider = createCustomWebProvider({ apiKey: API_KEY, baseUrl: BASE_URL, transport });
      const result = await provider.search("bounded");

      expect(JSON.parse(transport.mock.calls[0][0].body)).toEqual({
        query: "bounded",
        limit: 5,
      });
      expect(result.sources).toHaveLength(5);
      expect(result.sources.map((source) => source.url)).toEqual([
        "https://example.com/0",
        "https://example.com/1",
        "https://example.com/2",
        "https://example.com/3",
        "https://example.com/4",
      ]);
      expect(result.sources.some((source) => source.url.includes("127.0.0.1"))).toBe(false);
      expect(result.citations).toHaveLength(50);
      expect(new Set(result.citations).size).toBe(50);
      expect(result.citations).not.toContain("file:///private/note.md");
    });

    it.each([
      ["an empty query", "   ", undefined],
      ["an oversized query", "q".repeat(513), undefined],
      ["a zero limit", "valid", 0],
      ["a fractional limit", "valid", 1.5],
      ["a limit above the maximum", "valid", 11],
    ])("rejects %s before transport", async (_case, query, limit) => {
      const transport = transportMock();
      const provider = createCustomWebProvider({ apiKey: API_KEY, baseUrl: BASE_URL, transport });

      await expect(
        provider.search(query, limit === undefined ? undefined : { limit })
      ).rejects.toMatchObject({
        code: "invalid_query",
        status: null,
        message: "The search query is invalid.",
        retryable: false,
      });
      expect(transport).not.toHaveBeenCalled();
    });

    it.each([
      ["a wrong kind", searchResult({ kind: "web_fetch" })],
      ["missing content", searchResult({ content: undefined })],
      ["a non-array source collection", searchResult({ sources: {} })],
      ["a non-array citation collection", searchResult({ citations: {} })],
      ["a source without a title", searchResult({ sources: [{ url: "https://example.com" }] })],
      [
        "a source with invalid optional metadata",
        searchResult({
          sources: [{ title: "Example", url: "https://example.com", snippet: 42 }],
        }),
      ],
      ["a non-string citation", searchResult({ citations: [42] })],
      ["search content beyond its bound", searchResult({ content: "x".repeat(50001) })],
    ])("rejects %s as a malformed response", async (_case, json) => {
      const transport = transportMock();
      transport.mockResolvedValue(response(json));
      const provider = createCustomWebProvider({ apiKey: API_KEY, baseUrl: BASE_URL, transport });

      await expectMalformed(provider.search("malformed"));
    });

    it("accepts a JSON string response while retaining the same envelope validation", async () => {
      const transport = transportMock();
      transport.mockResolvedValue(response(JSON.stringify(searchResult())));
      const provider = createCustomWebProvider({ apiKey: API_KEY, baseUrl: BASE_URL, transport });

      await expect(provider.search("string response")).resolves.toMatchObject({
        kind: "web_search",
        content: "Search result",
      });
    });

    it("sanitizes an injected JSON parser failure", async () => {
      const transport = transportMock();
      transport.mockResolvedValue({
        status: 200,
        get json(): never {
          throw new Error(`provider parser leaked ${API_KEY}`);
        },
      });
      const provider = createCustomWebProvider({ apiKey: API_KEY, baseUrl: BASE_URL, transport });

      await expectMalformed(provider.search("parser failure"));
    });

    it("sends one public URL to the fetch endpoint and filters unsafe citations", async () => {
      const transport = transportMock();
      transport.mockResolvedValue(
        response(
          fetchResult({
            title: "  Example page  ",
            content: "  Fetched content\r\n",
            sources: [
              { title: "Example page", url: "https://example.com/page" },
              { title: "Private", url: "http://localhost/private" },
              { title: "Duplicate", url: "https://example.com/page" },
            ],
            citations: [
              "https://example.com/page",
              "https://example.com/page",
              "http://127.0.0.1/private",
            ],
          })
        )
      );

      const provider = createCustomWebProvider({ apiKey: API_KEY, baseUrl: BASE_URL, transport });
      const result = await provider.fetch("https://example.com/page");

      expect(result).toEqual({
        kind: "web_fetch",
        url: "https://example.com/page",
        title: "Example page",
        content: "Fetched content",
        sources: [{ title: "Example page", url: "https://example.com/page" }],
        citations: ["https://example.com/page"],
        truncated: false,
      });
      expect(transport.mock.calls[0][0].url).toBe("https://search.example.test/copilot/fetch");
      expect(JSON.parse(transport.mock.calls[0][0].body)).toEqual({
        url: "https://example.com/page",
      });
      expect(transport.mock.calls[0][0].body).not.toContain(API_KEY);
    });

    it.each([
      ["a mismatched public URL", fetchResult({ url: "https://other.example.test/page" })],
      ["a non-public returned URL", fetchResult({ url: "http://localhost/page" })],
      ["missing truncation metadata", fetchResult({ truncated: undefined })],
      ["a non-boolean truncation flag", fetchResult({ truncated: "false" })],
      ["fetch content beyond its bound", fetchResult({ content: "x".repeat(100001) })],
      ["a non-array source collection", fetchResult({ sources: {} })],
      ["a non-array citation collection", fetchResult({ citations: {} })],
    ])("rejects %s as a malformed fetch response", async (_case, json) => {
      const transport = transportMock();
      transport.mockResolvedValue(response(json));
      const provider = createCustomWebProvider({ apiKey: API_KEY, baseUrl: BASE_URL, transport });

      await expectMalformed(provider.fetch("https://example.com/page"));
    });

    it("rejects an unsafe requested fetch URL before transport", async () => {
      const transport = transportMock();
      const provider = createCustomWebProvider({ apiKey: API_KEY, baseUrl: BASE_URL, transport });

      await expect(provider.fetch("file:///vault/private.md")).rejects.toMatchObject({
        code: "invalid_url",
        status: null,
      });
      expect(transport).not.toHaveBeenCalled();
    });

    it.each([
      [401, "unauthorized"],
      [429, "rate_limited"],
      [500, "server"],
    ])("maps HTTP %p without exposing the API key", async (status, code) => {
      const transport = transportMock();
      transport.mockResolvedValue({ status, json: { error: `secret ${API_KEY}` } });
      const provider = createCustomWebProvider({ apiKey: API_KEY, baseUrl: BASE_URL, transport });

      const request = provider.search("safe query");
      await expect(request).rejects.toMatchObject({ code, status });
      await expect(request).rejects.not.toThrow(API_KEY);
    });

    it("sanitizes transport failures and does not retry", async () => {
      const transport = transportMock();
      transport.mockRejectedValue(new Error(`socket leaked ${API_KEY}`));
      const provider = createCustomWebProvider({ apiKey: API_KEY, baseUrl: BASE_URL, transport });

      await expect(provider.search("safe query")).rejects.toMatchObject({
        code: "network",
        status: null,
        message: "Could not reach Custom API.",
        retryable: true,
      });
      expect(transport).toHaveBeenCalledTimes(1);
    });

    it("does not invoke the transport after pre-cancellation", async () => {
      const transport = transportMock();
      const controller = new AbortController();
      controller.abort();
      const provider = createCustomWebProvider({ apiKey: API_KEY, baseUrl: BASE_URL, transport });

      await expect(
        provider.search("cancelled", { signal: controller.signal })
      ).rejects.toMatchObject({
        code: "timeout",
        message: "The Custom API request was cancelled.",
        retryable: true,
      });
      expect(transport).not.toHaveBeenCalled();
    });

    it("runs one explicit connection search with the smallest request", async () => {
      const transport = transportMock();
      transport.mockResolvedValue(
        response({ kind: "web_search", content: "", sources: [], citations: [] })
      );
      const provider = createCustomWebProvider({ apiKey: API_KEY, baseUrl: BASE_URL, transport });

      await expect(provider.testConnection()).resolves.toBeUndefined();
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transport.mock.calls[0][0].url).toBe("https://search.example.test/copilot/search");
      expect(JSON.parse(transport.mock.calls[0][0].body)).toEqual({
        query: "connection test",
        limit: 1,
      });
    });
  });
});
