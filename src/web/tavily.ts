import {
  defaultWebTransport,
  ensureSuccessfulResponse,
  requestWebProvider,
  utf8ByteLengthUpTo,
} from "@/web/providerHttp";
import { normalizePublicUrl, validatePublicUrl } from "@/web/publicUrl";
import {
  WebProviderError,
  type WebProvider,
  type WebProviderTransport,
  type WebSearchOptions,
  type WebSource,
} from "@/web/types";

const EMPTY_SOURCES = Object.freeze([]) as unknown as WebSource[];
const EMPTY_CITATIONS = Object.freeze([]) as unknown as string[];
const MAX_BODY_BYTES = 512 * 1024;
const MAX_FETCH_CHARS = 100000;

export interface CreateTavilyWebProviderOptions {
  apiKey: string;
  transport?: WebProviderTransport;
}

/**
 * Creates a settings-free client for Tavily Search and Extract. Only explicit
 * queries/URLs are sent; no vault reader, fallback, or automatic probe is owned here.
 * @param options The user's credential and optional injected HTTP transport.
 */
export function createTavilyWebProvider(options: CreateTavilyWebProviderOptions): WebProvider {
  if (
    !isRecord(options) ||
    typeof options.apiKey !== "string" ||
    (options.transport !== undefined && typeof options.transport !== "function")
  ) {
    throw new WebProviderError(
      "invalid_configuration",
      null,
      "Tavily provider configuration is invalid.",
      false
    );
  }
  const { apiKey } = options;
  if (apiKey.length < 8 || apiKey.length > 256 || /[^\x21-\x7e]/.test(apiKey)) {
    throw new WebProviderError(
      "invalid_credentials",
      null,
      "The Tavily API key is invalid.",
      false
    );
  }
  const transport = options.transport ?? defaultWebTransport;

  async function request(
    operation: "search" | "extract",
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const response = await requestWebProvider(
      "Tavily",
      transport,
      apiKey,
      `https://api.tavily.com/${operation}`,
      body,
      signal
    );
    // Tavily reports plan and pay-as-you-go exhaustion with these documented statuses.
    // https://docs.tavily.com/documentation/api-reference/endpoint/search
    if (response.status === 432 || response.status === 433) {
      throw new WebProviderError(
        "quota_exceeded",
        response.status,
        "Tavily account quota is unavailable for this request.",
        false
      );
    }
    ensureSuccessfulResponse(response, "Tavily");
    let value = response.json;
    if (typeof value === "string") {
      if (utf8ByteLengthUpTo(value, MAX_BODY_BYTES) > MAX_BODY_BYTES) throw malformed();
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        throw malformed();
      }
    }
    if (!isRecord(value) || !Array.isArray(value.results) || value.results.length > 1000)
      throw malformed();
    return value;
  }

  async function search(query: string, searchOptions?: WebSearchOptions) {
    const limit = searchOptions?.limit ?? 5;
    if (
      typeof query !== "string" ||
      !query.trim() ||
      query.trim().length > 512 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 10
    ) {
      throw new WebProviderError("invalid_query", null, "The search query is invalid.", false);
    }
    const payload = await request(
      "search",
      {
        query: query.trim(),
        max_results: limit,
        search_depth: "basic",
        topic: "general",
        auto_parameters: false,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_published_date: true,
      },
      searchOptions?.signal
    );
    const results = payload.results as unknown[];
    const sources: WebSource[] = [];
    const seen = new Set<string>();
    for (const item of results) {
      if (sources.length >= limit) break;
      if (!isRecord(item)) continue;
      const url = normalizePublicUrl(typeof item.url === "string" ? item.url : undefined);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const snippet = boundedText(item.content, 2000);
      const publishedAt = boundedText(item.published_date, 128);
      sources.push({
        title: boundedText(item.title, 300) ?? new URL(url).hostname,
        url,
        ...(snippet ? { snippet } : {}),
        ...(publishedAt ? { publishedAt } : {}),
      });
    }
    if (results.length > 0 && sources.length === 0) throw malformed();
    return {
      kind: "web_search" as const,
      content: sources
        .map((source) => [source.title, source.url, source.snippet].filter(Boolean).join("\n"))
        .join("\n\n"),
      sources: sources.length ? sources : EMPTY_SOURCES,
      citations: sources.length ? sources.map((source) => source.url) : EMPTY_CITATIONS,
    };
  }

  return {
    search,
    async fetch(url, fetchOptions) {
      const requestedUrl = validatePublicUrl(url);
      const payload = await request(
        "extract",
        {
          urls: [requestedUrl],
          extract_depth: "basic",
          format: "markdown",
          include_images: false,
          include_favicon: false,
          timeout: 20,
        },
        fetchOptions?.signal
      );
      const results = payload.results as unknown[];
      // One requested URL must yield one matching result; do not attribute another
      // page's text to the requested citation on partial or malformed responses.
      if (results.length !== 1 || !isRecord(results[0])) throw malformed();
      const item = results[0];
      if (
        normalizePublicUrl(typeof item.url === "string" ? item.url : undefined) !== requestedUrl ||
        typeof item.raw_content !== "string" ||
        (payload.failed_results !== undefined &&
          (!Array.isArray(payload.failed_results) || payload.failed_results.length > 0))
      )
        throw malformed();
      const content = boundedText(item.raw_content, MAX_FETCH_CHARS);
      if (!content) throw malformed();
      const title = boundedText(item.title, 300) ?? new URL(requestedUrl).hostname;
      return {
        kind: "web_fetch",
        url: requestedUrl,
        title,
        content,
        sources: [{ title, url: requestedUrl }],
        citations: [requestedUrl],
        truncated: item.raw_content.length > MAX_FETCH_CHARS,
      };
    },
    async testConnection() {
      await search("Tavily", { limit: 1 });
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .slice(0, maxLength)
    .replace(/\r\n?/g, "\n")
    .split(String.fromCharCode(0))
    .join("")
    .trim();
  return text || undefined;
}

function malformed(): WebProviderError {
  return new WebProviderError(
    "malformed_response",
    null,
    "Tavily returned an invalid response.",
    false
  );
}
