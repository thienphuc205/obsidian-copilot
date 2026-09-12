import { requestUrl } from "obsidian";
import { createExaWebProvider } from "@/web/exa";
import {
  WebProviderError,
  type WebProviderTransport,
  type WebProviderTransportResponse,
} from "@/web/types";

jest.mock("obsidian", () => ({ requestUrl: jest.fn() }));

const API_KEY = "exa-private-fixture";
const RESULT_URL = "https://example.com/docs";

function response(status: number, json: unknown): WebProviderTransportResponse {
  return { status, json };
}

function transportMock(): jest.MockedFunction<WebProviderTransport> {
  return jest.fn();
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
    expect((error as Error).message).not.toContain(API_KEY);
  }
}

describe("exa", () => {
  describe("createExaWebProvider()", () => {
    const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>;

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it.each(["", "exa-key", "exa-key\nsecret", "exa-key secret", "x".repeat(257)])(
      "rejects invalid credentials %p before network access",
      (apiKey) => {
        const transport = transportMock();

        expect(() => createExaWebProvider({ apiKey, transport })).toThrow(WebProviderError);
        expect(transport).not.toHaveBeenCalled();
      }
    );

    it("rejects invalid configuration without making a request", () => {
      expect(() => createExaWebProvider(null as never)).toThrow(WebProviderError);
      expect(() => createExaWebProvider({ apiKey: API_KEY, transport: 1 as never })).toThrow(
        WebProviderError
      );
      expect(mockedRequestUrl).not.toHaveBeenCalled();
    });

    it("returns settings-free methods without an automatic probe", () => {
      const provider = createExaWebProvider({ apiKey: API_KEY });

      expect(typeof provider.search).toBe("function");
      expect(typeof provider.fetch).toBe("function");
      expect(typeof provider.testConnection).toBe("function");
      expect(mockedRequestUrl).not.toHaveBeenCalled();
    });

    describe("search()", () => {
      it("sends only the bounded query with Exa authentication and normalizes citations", async () => {
        const transport = transportMock().mockResolvedValue(
          response(200, {
            results: [
              {
                title: "  Exa docs  ",
                url: `${RESULT_URL}#intro`,
                publishedDate: "2026-09-10",
                highlights: ["  A useful result.  "],
              },
              {
                title: "Private result",
                url: "http://127.0.0.1/private",
                highlights: ["Must not become a citation."],
              },
            ],
          })
        );

        const result = await createExaWebProvider({ apiKey: API_KEY, transport }).search(
          " public docs ",
          { limit: 2 }
        );

        expect(result).toEqual({
          kind: "web_search",
          content: "Exa docs\nhttps://example.com/docs#intro\nA useful result.",
          sources: [
            {
              title: "Exa docs",
              url: "https://example.com/docs#intro",
              snippet: "A useful result.",
              publishedAt: "2026-09-10",
            },
          ],
          citations: ["https://example.com/docs#intro"],
        });

        const request = transport.mock.calls[0][0];
        expect(request).toMatchObject({
          url: "https://api.exa.ai/search",
          method: "POST",
          contentType: "application/json",
          timeoutMs: 30000,
        });
        expect(request.headers).toEqual({ "x-api-key": API_KEY });
        expect(request.headers).not.toHaveProperty("Authorization");
        expect(JSON.parse(request.body)).toEqual({
          query: "public docs",
          type: "auto",
          numResults: 2,
          contents: { highlights: { maxCharacters: 2000 } },
        });
        expect(request.body).not.toContain(API_KEY);
      });

      it("uses the default limit and fixed endpoint through the default transport", async () => {
        mockedRequestUrl.mockResolvedValue({
          status: 200,
          headers: {},
          text: JSON.stringify({ results: [] }),
          arrayBuffer: new ArrayBuffer(0),
          json: { results: [] },
        });

        const provider = createExaWebProvider({ apiKey: API_KEY });
        await expect(provider.search("status check")).resolves.toMatchObject({
          kind: "web_search",
          content: "",
          sources: [],
          citations: [],
        });

        expect(mockedRequestUrl).toHaveBeenCalledTimes(1);
        const request = mockedRequestUrl.mock.calls[0][0];
        if (typeof request === "string") throw new Error("Expected POST request parameters");
        expect(request.url).toBe("https://api.exa.ai/search");
        expect(request.headers).toEqual({ "x-api-key": API_KEY });
        expect(JSON.parse(request.body as string)).toEqual({
          query: "status check",
          type: "auto",
          numResults: 5,
          contents: { highlights: { maxCharacters: 2000 } },
        });
      });

      it.each([
        ["", undefined],
        ["x".repeat(513), undefined],
        ["query", 0],
        ["query", 11],
        ["query", 1.5],
      ])("rejects invalid query or limit %p %p before transport", async (query, limit) => {
        const transport = transportMock();
        const provider = createExaWebProvider({ apiKey: API_KEY, transport });

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

      it("deduplicates, filters private URLs, and bounds source metadata", async () => {
        const transport = transportMock().mockResolvedValue(
          response(200, {
            results: [
              { url: "http://127.0.0.1/secret" },
              {
                url: RESULT_URL,
                title: "t".repeat(1000),
                highlights: ["s".repeat(10000)],
              },
              { url: RESULT_URL, title: "duplicate" },
              ...Array.from({ length: 12 }, (_, index) => ({
                url: `https://example.com/${index}`,
                title: `title-${index}`,
                highlights: [`snippet-${index}`],
              })),
            ],
          })
        );

        const result = await createExaWebProvider({ apiKey: API_KEY, transport }).search("docs", {
          limit: 10,
        });

        expect(result.sources).toHaveLength(10);
        expect(new Set(result.citations).size).toBe(10);
        expect(result.sources[0]).toMatchObject({
          title: "t".repeat(300),
          snippet: "s".repeat(2000),
        });
        expect(result.content).not.toContain("127.0.0.1");
      });

      it("returns stable empty source collections for an empty response", async () => {
        const transport = transportMock().mockResolvedValue(response(200, { results: [] }));
        const provider = createExaWebProvider({ apiKey: API_KEY, transport });

        const first = await provider.search("none");
        const second = await provider.search("none");

        expect(first.sources).toBe(second.sources);
        expect(first.citations).toBe(second.citations);
        expect(first.content).toBe("");
        expect(Object.isFrozen(first.sources)).toBe(true);
        expect(Object.isFrozen(first.citations)).toBe(true);
      });

      it.each([
        null,
        { results: {} },
        { results: Array(1001).fill({ url: RESULT_URL }) },
        { results: [{ url: "file:///private" }] },
      ])("rejects malformed or unusable search output %p", async (json) => {
        const transport = transportMock().mockResolvedValue(response(200, json));

        await expectProviderError(
          createExaWebProvider({ apiKey: API_KEY, transport }).search("docs"),
          {
            code: "malformed_response",
            status: null,
            message: "Exa returned an invalid response.",
            retryable: false,
          }
        );
      });

      it("rejects an oversized raw body before reading JSON", async () => {
        const readJson = jest.fn(() => ({ results: [] }));
        const transport = transportMock().mockResolvedValue({
          status: 200,
          text: "界".repeat(200000),
          get json(): unknown {
            return readJson();
          },
        });

        await expectProviderError(
          createExaWebProvider({ apiKey: API_KEY, transport }).search("docs"),
          {
            code: "malformed_response",
            status: null,
            message: "Exa returned an invalid response.",
            retryable: false,
          }
        );
        expect(readJson).not.toHaveBeenCalled();
      });
    });

    describe("fetch()", () => {
      it("requests one public URL through Contents and bounds returned text", async () => {
        const transport = transportMock().mockResolvedValue(
          response(200, {
            results: [
              {
                id: RESULT_URL,
                url: RESULT_URL,
                title: "Fetched page",
                publishedDate: "2026-09-11",
                text: "a".repeat(100001),
              },
            ],
            statuses: [{ id: RESULT_URL, status: "success" }],
          })
        );

        const result = await createExaWebProvider({ apiKey: API_KEY, transport }).fetch(RESULT_URL);

        expect(result).toMatchObject({
          kind: "web_fetch",
          url: RESULT_URL,
          title: "Fetched page",
          content: "a".repeat(100000),
          truncated: true,
          sources: [{ title: "Fetched page", url: RESULT_URL, publishedAt: "2026-09-11" }],
          citations: [RESULT_URL],
        });
        expect(result.content).toHaveLength(100000);

        const request = transport.mock.calls[0][0];
        expect(request.url).toBe("https://api.exa.ai/contents");
        expect(request.headers).toEqual({ Authorization: `Bearer ${API_KEY}` });
        expect(JSON.parse(request.body)).toEqual({
          urls: [RESULT_URL],
          text: { maxCharacters: 100000 },
        });
        expect(request.body).not.toContain(API_KEY);
      });

      it.each([
        "file:///vault/note.md",
        "http://localhost/page",
        "http://10.0.0.1/page",
        "https://user:password@example.com/page",
      ])("rejects nonpublic URL %p before calling Contents", async (url) => {
        const transport = transportMock();
        const provider = createExaWebProvider({ apiKey: API_KEY, transport });

        await expect(provider.fetch(url)).rejects.toMatchObject({
          code: "invalid_url",
          status: null,
          message: "Only public HTTP(S) URLs can be fetched.",
          retryable: false,
        });
        expect(transport).not.toHaveBeenCalled();
      });

      it.each([
        {
          results: [{ url: "https://other.example.com", text: "wrong page" }],
          statuses: [{ id: RESULT_URL, status: "success" }],
        },
        {
          results: [{ id: "https://other.example.com", url: RESULT_URL, text: "wrong page" }],
          statuses: [{ id: RESULT_URL, status: "success" }],
        },
        {
          results: [{ id: RESULT_URL, url: RESULT_URL, text: "page" }],
          statuses: [{ id: RESULT_URL, status: "error" }],
        },
        {
          results: [{ id: RESULT_URL, url: RESULT_URL, text: "page" }],
          statuses: [{ id: "https://other.example.com", status: "success" }],
        },
        {
          results: [{ id: RESULT_URL, url: RESULT_URL, text: "page" }],
          statuses: "broken",
        },
        {
          results: [{ id: RESULT_URL, url: RESULT_URL, text: "page" }],
        },
      ])("fails closed on mismatched or unsuccessful Contents attribution", async (json) => {
        const transport = transportMock().mockResolvedValue(response(200, json));

        await expectProviderError(
          createExaWebProvider({ apiKey: API_KEY, transport }).fetch(RESULT_URL),
          {
            code: "malformed_response",
            status: null,
            message: "Exa returned an invalid response.",
            retryable: false,
          }
        );
      });

      it("rejects empty or missing fetched text without exposing the response", async () => {
        const transport = transportMock().mockResolvedValue(
          response(200, {
            results: [{ id: RESULT_URL, url: RESULT_URL, text: "   " }],
            statuses: [{ id: RESULT_URL, status: "success" }],
          })
        );

        await expectProviderError(
          createExaWebProvider({ apiKey: API_KEY, transport }).fetch(RESULT_URL),
          {
            code: "malformed_response",
            status: null,
            message: "Exa returned an invalid response.",
            retryable: false,
          }
        );
      });
    });

    describe("testConnection()", () => {
      it("performs exactly one small explicit Search request", async () => {
        const transport = transportMock().mockResolvedValue(response(200, { results: [] }));
        const provider = createExaWebProvider({ apiKey: API_KEY, transport });

        expect(transport).not.toHaveBeenCalled();
        await expect(provider.testConnection()).resolves.toBeUndefined();

        expect(transport).toHaveBeenCalledTimes(1);
        const request = transport.mock.calls[0][0];
        expect(request.url).toBe("https://api.exa.ai/search");
        expect(JSON.parse(request.body)).toEqual({
          query: "Exa",
          type: "auto",
          numResults: 1,
          contents: { highlights: { maxCharacters: 2000 } },
        });
      });
    });

    describe("provider failures", () => {
      it.each([
        [400, "bad_request", "Exa rejected the request.", false],
        [401, "unauthorized", "Exa rejected the API key.", false],
        [402, "quota_exceeded", "Exa account quota is unavailable for this request.", false],
        [429, "rate_limited", "Exa rate limit reached. Try again later.", true],
        [500, "server", "Exa is temporarily unavailable.", true],
      ])(
        "maps HTTP %p to a sanitized %p error without exposing the response body",
        async (status, code, message, retryable) => {
          const transport = transportMock().mockResolvedValue(
            response(status, { error: `provider leaked ${API_KEY}` })
          );

          await expectProviderError(
            createExaWebProvider({ apiKey: API_KEY, transport }).search("docs"),
            {
              code: code as WebProviderError["code"],
              status,
              message,
              retryable,
            }
          );
        }
      );

      it("sanitizes transport rejection and never retries", async () => {
        const transport = transportMock().mockRejectedValue(new Error(API_KEY));

        await expectProviderError(
          createExaWebProvider({ apiKey: API_KEY, transport }).search("docs"),
          {
            code: "network",
            status: null,
            message: "Could not reach Exa.",
            retryable: true,
          }
        );
        expect(transport).toHaveBeenCalledTimes(1);
      });

      it("does not invoke the transport when cancellation was already requested", async () => {
        const transport = transportMock();
        const controller = new AbortController();
        controller.abort();

        await expect(
          createExaWebProvider({ apiKey: API_KEY, transport }).search("cancelled", {
            signal: controller.signal,
          })
        ).rejects.toMatchObject({
          code: "timeout",
          status: null,
          message: "The Exa request was cancelled.",
          retryable: true,
        });
        expect(transport).not.toHaveBeenCalled();
      });

      it("propagates cooperative cancellation to the injected transport", async () => {
        const transport = transportMock().mockReturnValue(new Promise(() => {}));
        const controller = new AbortController();
        const pending = createExaWebProvider({ apiKey: API_KEY, transport }).search("cancelled", {
          signal: controller.signal,
        });

        await Promise.resolve();
        expect(transport.mock.calls[0][0].signal).toBe(controller.signal);
        controller.abort();

        await expectProviderError(pending, {
          code: "timeout",
          status: null,
          message: "The Exa request was cancelled.",
          retryable: true,
        });
      });

      it("returns a bounded deadline error for a hanging transport", async () => {
        jest.useFakeTimers();
        try {
          const transport = transportMock().mockReturnValue(new Promise(() => {}));
          const pending = createExaWebProvider({ apiKey: API_KEY, transport }).search("docs");

          await Promise.resolve();
          jest.advanceTimersByTime(30000);
          await expectProviderError(pending, {
            code: "timeout",
            status: null,
            message: "Exa did not respond before the request deadline.",
            retryable: true,
          });
        } finally {
          jest.useRealTimers();
        }
      });
    });
  });
});
