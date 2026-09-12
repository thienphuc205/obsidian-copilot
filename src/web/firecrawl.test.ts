import { createFirecrawlWebProvider } from "@/web/firecrawl";
import {
  WebProviderError,
  type WebProviderTransport,
  type WebProviderTransportResponse,
} from "@/web/types";
import { requestUrl, type RequestUrlResponse } from "obsidian";

jest.mock("obsidian", () => ({
  requestUrl: jest.fn(),
}));

const TEST_API_KEY = "fc-test-key-123456";

function response(status: number, json: unknown): WebProviderTransportResponse {
  return { status, json };
}

function requestUrlResponse(status: number, json: unknown): RequestUrlResponse {
  return {
    status,
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
    json,
    text: typeof json === "string" ? json : JSON.stringify(json),
  };
}

function transportMock(): jest.MockedFunction<WebProviderTransport> {
  return jest.fn() as jest.MockedFunction<WebProviderTransport>;
}

async function expectProviderError(
  promise: Promise<unknown>,
  expected: {
    code: WebProviderError["code"];
    status: number | null;
    message: string;
    retryable: boolean;
  }
): Promise<void> {
  await expect(promise).rejects.toMatchObject(expected);
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WebProviderError);
    expect((error as Error).message).not.toContain(TEST_API_KEY);
  }
}

describe("firecrawl", () => {
  describe("WebProviderError", () => {
    describe("constructor()", () => {
      it("retains only the categorized fields needed by callers", () => {
        const error = new WebProviderError("unauthorized", 401, "Key rejected.", false);

        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({
          name: "WebProviderError",
          code: "unauthorized",
          status: 401,
          message: "Key rejected.",
          retryable: false,
        });
      });
    });
  });

  describe("createFirecrawlWebProvider()", () => {
    const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>;

    beforeEach(() => {
      mockedRequestUrl.mockReset();
    });

    describe("factory configuration", () => {
      it.each([
        ["an empty key", ""],
        ["a whitespace-only key", "        "],
        ["a key containing a newline", "fc-valid\nkey"],
        ["a key shorter than the minimum", "fc-test"],
      ])("rejects %s without making a request", (_case, apiKey) => {
        expect(() => createFirecrawlWebProvider({ apiKey })).toThrow(WebProviderError);
        expect(mockedRequestUrl).not.toHaveBeenCalled();
      });

      it("returns the settings-free provider methods without making an automatic request", () => {
        const provider = createFirecrawlWebProvider({ apiKey: TEST_API_KEY });

        expect(typeof provider.search).toBe("function");
        expect(typeof provider.fetch).toBe("function");
        expect(typeof provider.testConnection).toBe("function");
        expect(mockedRequestUrl).not.toHaveBeenCalled();
      });
    });

    describe("search()", () => {
      it("posts only the bounded query contract and normalizes safe citations", async () => {
        const transport = transportMock();
        transport.mockResolvedValue(
          response(200, {
            success: true,
            data: {
              web: [
                {
                  title: "  Example docs  ",
                  url: "https://example.com/docs#intro",
                  description: "  A useful result.  ",
                  publishedDate: "2026-01-02",
                },
                {
                  title: "Private result",
                  url: "http://127.0.0.1/private",
                  description: "Must not become a citation.",
                },
              ],
            },
          })
        );

        const provider = createFirecrawlWebProvider({ apiKey: TEST_API_KEY, transport });
        const result = await provider.search("  public docs  ", { limit: 2 });

        expect(result.kind).toBe("web_search");
        expect(result.content).toContain("https://example.com/docs#intro");
        expect(result.sources).toEqual([
          {
            title: "Example docs",
            url: "https://example.com/docs#intro",
            snippet: "A useful result.",
            publishedAt: "2026-01-02",
          },
        ]);
        expect(result.citations).toEqual(["https://example.com/docs#intro"]);
        expect(JSON.parse(transport.mock.calls[0][0].body)).toEqual({
          query: "public docs",
          limit: 2,
          sources: ["web"],
          timeout: 30000,
        });
        expect(transport.mock.calls[0][0]).toMatchObject({
          url: "https://api.firecrawl.dev/v2/search",
          method: "POST",
          headers: { Authorization: `Bearer ${TEST_API_KEY}` },
          contentType: "application/json",
          timeoutMs: 30000,
        });
        expect(transport.mock.calls[0][0].body).not.toContain("chatHistory");
        expect(transport.mock.calls[0][0].body).not.toContain("context");
      });

      it("uses the default requestUrl transport with the fixed endpoint", async () => {
        mockedRequestUrl.mockResolvedValue(
          requestUrlResponse(200, { success: true, data: { web: [] } })
        );

        const provider = createFirecrawlWebProvider({ apiKey: TEST_API_KEY });
        await expect(provider.search("status check")).resolves.toMatchObject({
          kind: "web_search",
          content: "",
          sources: [],
          citations: [],
        });

        expect(mockedRequestUrl).toHaveBeenCalledWith({
          url: "https://api.firecrawl.dev/v2/search",
          method: "POST",
          headers: { Authorization: `Bearer ${TEST_API_KEY}` },
          contentType: "application/json",
          body: JSON.stringify({
            query: "status check",
            limit: 5,
            sources: ["web"],
            timeout: 30000,
          }),
          throw: false,
        });
      });

      it("accepts the legacy flat data-array search envelope", async () => {
        const transport = transportMock();
        transport.mockResolvedValue(
          response(200, {
            success: true,
            data: [
              {
                title: "Flat result",
                url: "https://example.com/flat",
                description: "A legacy-compatible result.",
              },
            ],
          })
        );

        const result = await createFirecrawlWebProvider({
          apiKey: TEST_API_KEY,
          transport,
        }).search("flat envelope", { limit: 1 });

        expect(result.sources).toEqual([
          {
            title: "Flat result",
            url: "https://example.com/flat",
            snippet: "A legacy-compatible result.",
          },
        ]);
        expect(result.citations).toEqual(["https://example.com/flat"]);
      });

      it("rejects a search array that exceeds the parser work bound", async () => {
        const transport = transportMock();
        transport.mockResolvedValue(
          response(200, {
            success: true,
            data: Array.from({ length: 1001 }, () => ({
              title: "Ignored",
              url: "https://example.com/ignored",
            })),
          })
        );

        const provider = createFirecrawlWebProvider({ apiKey: TEST_API_KEY, transport });
        await expectProviderError(provider.search("bounded"), {
          code: "malformed_response",
          status: null,
          message: "Firecrawl returned an invalid response.",
          retryable: false,
        });
      });

      it("rejects an oversized multibyte raw body before reading response.json", async () => {
        const transport = transportMock();
        let parsed = false;
        const rawBody = "界".repeat(200_000);
        const rawResponse: WebProviderTransportResponse = {
          status: 200,
          text: rawBody,
          get json(): unknown {
            parsed = true;
            return { success: true, data: { web: [] } };
          },
        };
        transport.mockResolvedValue(rawResponse);

        const provider = createFirecrawlWebProvider({ apiKey: TEST_API_KEY, transport });
        await expectProviderError(provider.search("raw bound"), {
          code: "malformed_response",
          status: null,
          message: "Firecrawl returned an invalid response.",
          retryable: false,
        });
        expect(parsed).toBe(false);
      });

      it("does not invoke the transport when cancellation was already requested", async () => {
        const transport = transportMock();
        const controller = new AbortController();
        controller.abort();
        const provider = createFirecrawlWebProvider({ apiKey: TEST_API_KEY, transport });

        await expect(
          provider.search("cancelled", { signal: controller.signal })
        ).rejects.toMatchObject({
          code: "timeout",
          status: null,
          message: "The Firecrawl request was cancelled.",
          retryable: true,
        });
        expect(transport).not.toHaveBeenCalled();
      });

      it.each([
        ["an empty query", "   ", undefined],
        ["an oversized query", "q".repeat(513), undefined],
        ["a zero limit", "valid", 0],
        ["a fractional limit", "valid", 1.5],
        ["a limit above the provider bound", "valid", 11],
      ])("rejects %s before transport", async (_case, query, limit) => {
        const transport = transportMock();
        const provider = createFirecrawlWebProvider({ apiKey: TEST_API_KEY, transport });

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

      it("returns frozen empty slices for a valid empty response", async () => {
        const transport = transportMock();
        transport.mockResolvedValue(response(200, { success: true, data: { web: [] } }));

        const result = await createFirecrawlWebProvider({
          apiKey: TEST_API_KEY,
          transport,
        }).search("no results");

        expect(result.sources).toEqual([]);
        expect(result.citations).toEqual([]);
        expect(Object.isFrozen(result.sources)).toBe(true);
        expect(Object.isFrozen(result.citations)).toBe(true);
      });
    });

    describe("fetch()", () => {
      it("posts only the public URL scrape contract and bounds returned markdown", async () => {
        const transport = transportMock();
        const markdown = `${"content ".repeat(15000)}tail`;
        transport.mockResolvedValue(
          response(200, {
            success: true,
            data: {
              markdown,
              metadata: {
                title: "Fetched page",
                description: "A page description",
                publishedDate: "2026-02-03",
              },
              links: [
                "https://example.com/linked",
                "https://example.com/linked",
                "http://localhost/unsafe",
                "not a URL",
              ],
            },
          })
        );

        const provider = createFirecrawlWebProvider({ apiKey: TEST_API_KEY, transport });
        const result = await provider.fetch("https://example.com/page");

        expect(result.kind).toBe("web_fetch");
        expect(result.url).toBe("https://example.com/page");
        expect(result.title).toBe("Fetched page");
        expect(result.content.length).toBe(100000);
        expect(result.truncated).toBe(true);
        expect(result.sources).toEqual([
          {
            title: "Fetched page",
            url: "https://example.com/page",
            snippet: "A page description",
            publishedAt: "2026-02-03",
          },
        ]);
        expect(result.citations).toEqual([
          "https://example.com/page",
          "https://example.com/linked",
        ]);
        expect(JSON.parse(transport.mock.calls[0][0].body)).toEqual({
          url: "https://example.com/page",
          formats: ["markdown"],
          onlyMainContent: true,
          removeBase64Images: true,
          blockAds: true,
          timeout: 30000,
        });
        expect(transport.mock.calls[0][0].url).toBe("https://api.firecrawl.dev/v2/scrape");
      });

      it.each([
        ["a localhost hostname", "http://localhost/page"],
        ["a loopback IPv4 literal", "http://127.0.0.1/page"],
        ["a private IPv4 literal", "https://192.168.1.10/page"],
        ["a loopback IPv6 literal", "http://[::1]/page"],
        ["a local DNS suffix", "https://printer.local/page"],
        ["a URL with embedded credentials", "https://user:password@example.com/page"],
        ["a non-HTTP scheme", "file:///tmp/note.md"],
        ["a malformed URL", "not-a-url"],
      ])("rejects %s before transport", async (_case, url) => {
        const transport = transportMock();
        const provider = createFirecrawlWebProvider({ apiKey: TEST_API_KEY, transport });

        await expect(provider.fetch(url)).rejects.toMatchObject({
          code: "invalid_url",
          status: null,
          message: "Only public HTTP(S) URLs can be fetched.",
          retryable: false,
        });
        expect(transport).not.toHaveBeenCalled();
      });

      it("rejects an oversized URL before transport", async () => {
        const transport = transportMock();
        const provider = createFirecrawlWebProvider({ apiKey: TEST_API_KEY, transport });

        await expect(
          provider.fetch(`https://example.com/${"x".repeat(2048)}`)
        ).rejects.toMatchObject({
          code: "invalid_url",
          status: null,
        });
        expect(transport).not.toHaveBeenCalled();
      });

      it("rejects a links array that exceeds the citation parser bound", async () => {
        const transport = transportMock();
        transport.mockResolvedValue(
          response(200, {
            success: true,
            data: {
              markdown: "A bounded page.",
              links: Array.from({ length: 201 }, (_, index) => `https://example.com/${index}`),
            },
          })
        );

        const provider = createFirecrawlWebProvider({ apiKey: TEST_API_KEY, transport });
        await expectProviderError(provider.fetch("https://example.com/page"), {
          code: "malformed_response",
          status: null,
          message: "Firecrawl returned an invalid response.",
          retryable: false,
        });
      });
    });

    describe("testConnection()", () => {
      it("uses one small explicit search request and returns no response data", async () => {
        const transport = transportMock();
        transport.mockResolvedValue(response(200, { success: true, data: { web: [] } }));

        await expect(
          createFirecrawlWebProvider({ apiKey: TEST_API_KEY, transport }).testConnection()
        ).resolves.toBeUndefined();
        expect(transport).toHaveBeenCalledTimes(1);
        expect(JSON.parse(transport.mock.calls[0][0].body)).toEqual({
          query: "Firecrawl",
          limit: 1,
          sources: ["web"],
          timeout: 30000,
        });
      });
    });

    describe("provider failures", () => {
      it.each([
        [401, "unauthorized", "Firecrawl rejected the API key.", false],
        [429, "rate_limited", "Firecrawl rate limit reached. Try again later.", true],
        [500, "server", "Firecrawl is temporarily unavailable.", true],
      ])(
        "categorizes HTTP %s without exposing the response body",
        async (status, code, message, retryable) => {
          const transport = transportMock();
          transport.mockResolvedValue(
            response(status, { error: `secret response for ${TEST_API_KEY}` })
          );

          const provider = createFirecrawlWebProvider({ apiKey: TEST_API_KEY, transport });
          await expectProviderError(provider.search("safe query"), {
            code: code as WebProviderError["code"],
            status,
            message,
            retryable,
          });
        }
      );

      it("categorizes malformed success envelopes without exposing their body", async () => {
        const transport = transportMock();
        transport.mockResolvedValue(
          response(200, { success: true, data: { unexpected: TEST_API_KEY } })
        );

        const provider = createFirecrawlWebProvider({ apiKey: TEST_API_KEY, transport });
        await expectProviderError(provider.search("safe query"), {
          code: "malformed_response",
          status: null,
          message: "Firecrawl returned an invalid response.",
          retryable: false,
        });
      });

      it("categorizes malformed transport envelopes without a raw property error", async () => {
        const transport = transportMock();
        transport.mockResolvedValue({
          status: "200",
          json: { success: true, data: { web: [] } },
        } as unknown as WebProviderTransportResponse);

        const provider = createFirecrawlWebProvider({ apiKey: TEST_API_KEY, transport });
        await expectProviderError(provider.search("safe query"), {
          code: "malformed_response",
          status: null,
          message: "Firecrawl returned an invalid response.",
          retryable: false,
        });
      });

      it("sanitizes transport failures", async () => {
        const transport = transportMock();
        transport.mockRejectedValue(new Error(`socket leaked ${TEST_API_KEY}`));

        const provider = createFirecrawlWebProvider({ apiKey: TEST_API_KEY, transport });
        await expectProviderError(provider.fetch("https://example.com"), {
          code: "network",
          status: null,
          message: "Could not reach Firecrawl.",
          retryable: true,
        });
      });

      it("sanitizes provider-shaped transport failures", async () => {
        const transport = transportMock();
        transport.mockRejectedValue(
          new WebProviderError("server", 500, `transport leaked ${TEST_API_KEY}`, true)
        );

        const provider = createFirecrawlWebProvider({ apiKey: TEST_API_KEY, transport });
        await expectProviderError(provider.search("safe query"), {
          code: "network",
          status: null,
          message: "Could not reach Firecrawl.",
          retryable: true,
        });
      });

      it("returns a deadline error when the requestUrl-compatible transport hangs", async () => {
        jest.useFakeTimers();
        try {
          const transport = transportMock();
          transport.mockReturnValue(new Promise<WebProviderTransportResponse>(() => {}));
          const provider = createFirecrawlWebProvider({ apiKey: TEST_API_KEY, transport });
          const pending = provider.search("safe query");

          await Promise.resolve();
          jest.advanceTimersByTime(30000);
          await expectProviderError(pending, {
            code: "timeout",
            status: null,
            message: "Firecrawl did not respond before the request deadline.",
            retryable: true,
          });
        } finally {
          jest.useRealTimers();
        }
      });

      it("categorizes malformed fetch payloads and malformed connection payloads", async () => {
        const transport = transportMock();
        transport.mockResolvedValue(response(200, { success: true, data: { markdown: 42 } }));
        const provider = createFirecrawlWebProvider({ apiKey: TEST_API_KEY, transport });

        await expect(provider.fetch("https://example.com")).rejects.toMatchObject({
          code: "malformed_response",
          message: "Firecrawl returned an invalid response.",
        });

        transport.mockResolvedValue(response(200, { success: true, data: {} }));
        await expect(provider.testConnection()).rejects.toMatchObject({
          code: "malformed_response",
          message: "Firecrawl returned an invalid response.",
        });
      });
    });
  });
});
