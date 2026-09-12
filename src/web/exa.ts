import {
  defaultWebTransport,
  ensureSuccessfulResponse,
  requestWebProvider,
  utf8ByteLengthUpTo,
} from "@/web/providerHttp";
import { normalizePublicUrl, validatePublicUrl } from "@/web/publicUrl";
import {
  WebProviderError,
  type WebFetchOptions,
  type WebFetchResult,
  type WebProvider,
  type WebProviderTransport,
  type WebSearchOptions,
  type WebSearchResult,
  type WebSource,
} from "@/web/types";

const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";
const EXA_CONTENTS_ENDPOINT = "https://api.exa.ai/contents";
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;
const MAX_QUERY_LENGTH = 512;
const MIN_API_KEY_LENGTH = 8;
const MAX_API_KEY_LENGTH = 256;
const MAX_TITLE_LENGTH = 300;
const MAX_PUBLISHED_AT_LENGTH = 128;
const MAX_SEARCH_SNIPPET_LENGTH = 2000;
const MAX_SEARCH_CONTENT_LENGTH = 50000;
const MAX_FETCH_CONTENT_LENGTH = 100000;
const MAX_SEARCH_ITEMS = 1000;
const MAX_HIGHLIGHTS = 20;
const MAX_PROVIDER_BODY_BYTES = 512 * 1024;
const CONNECTION_QUERY = "Exa";

const EMPTY_SOURCES: WebSource[] = Object.freeze([]) as unknown as WebSource[];
const EMPTY_CITATIONS: string[] = Object.freeze([]) as unknown as string[];

/** Optional transport override for deterministic tests or a future host adapter. */
export interface CreateExaWebProviderOptions {
  apiKey: string;
  transport?: WebProviderTransport;
}

/**
 * Creates a settings-free provider for Exa's fixed Search and Contents APIs.
 *
 * Search returns bounded citation metadata and extractive highlights. Fetch
 * retrieves text for exactly one validated public URL. This boundary owns no
 * settings, vault, prompt, fallback, retry, or generated-answer behavior.
 *
 * @param options The API key and optional injected transport for Exa calls.
 */
export function createExaWebProvider(options: CreateExaWebProviderOptions): WebProvider {
  if (
    !isRecord(options) ||
    typeof options.apiKey !== "string" ||
    (options.transport !== undefined && typeof options.transport !== "function")
  ) {
    throw invalidConfigurationError();
  }
  validateApiKey(options.apiKey);

  const transport = options.transport ?? defaultWebTransport;
  const searchTransport = withExaSearchAuthentication(transport, options.apiKey);
  return {
    search: (query, searchOptions) =>
      searchWithExa(searchTransport, options.apiKey, query, searchOptions),
    fetch: (url, fetchOptions) => fetchWithExa(transport, options.apiKey, url, fetchOptions),
    testConnection: () => testExaConnection(searchTransport, options.apiKey),
  };
}

async function searchWithExa(
  transport: WebProviderTransport,
  apiKey: string,
  query: string,
  options?: WebSearchOptions
): Promise<WebSearchResult> {
  const normalizedQuery = validateQuery(query);
  const limit = validateSearchLimit(options?.limit);
  const payload = await requestExa(
    transport,
    apiKey,
    EXA_SEARCH_ENDPOINT,
    {
      query: normalizedQuery,
      type: "auto",
      numResults: limit,
      contents: {
        highlights: { maxCharacters: MAX_SEARCH_SNIPPET_LENGTH },
      },
    },
    options?.signal
  );
  return parseSearchResult(payload, limit);
}

async function fetchWithExa(
  transport: WebProviderTransport,
  apiKey: string,
  url: string,
  options?: WebFetchOptions
): Promise<WebFetchResult> {
  const requestedUrl = validatePublicUrl(url);
  const payload = await requestExa(
    transport,
    apiKey,
    EXA_CONTENTS_ENDPOINT,
    {
      urls: [requestedUrl],
      text: { maxCharacters: MAX_FETCH_CONTENT_LENGTH },
    },
    options?.signal
  );
  return parseFetchResult(payload, requestedUrl);
}

async function testExaConnection(transport: WebProviderTransport, apiKey: string): Promise<void> {
  await searchWithExa(transport, apiKey, CONNECTION_QUERY, { limit: 1 });
}

async function requestExa(
  transport: WebProviderTransport,
  apiKey: string,
  endpoint: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const response = await requestWebProvider("Exa", transport, apiKey, endpoint, body, signal);
  ensureSuccessfulResponse(response, "Exa");
  return parsePayload(response.json);
}

function parseSearchResult(payload: Record<string, unknown>, limit: number): WebSearchResult {
  const results = payload.results;
  if (!Array.isArray(results) || results.length > MAX_SEARCH_ITEMS) {
    throw malformedResponseError();
  }

  const sources: WebSource[] = [];
  const contentParts: string[] = [];
  const seenUrls = new Set<string>();
  for (const item of results) {
    if (sources.length >= limit) break;
    if (!isRecord(item)) continue;

    const url = normalizePublicUrl(getString(item.url));
    if (url === undefined || seenUrls.has(url)) continue;
    seenUrls.add(url);

    const title = boundedText(item.title, MAX_TITLE_LENGTH) ?? getDefaultTitle(url);
    const snippet = getSearchSnippet(item.highlights);
    const publishedAt = boundedText(item.publishedDate, MAX_PUBLISHED_AT_LENGTH);
    const source: WebSource = { title, url };
    if (snippet !== undefined) source.snippet = snippet;
    if (publishedAt !== undefined) source.publishedAt = publishedAt;

    sources.push(source);
    contentParts.push(formatSearchSource(source));
  }

  if (results.length > 0 && sources.length === 0) {
    throw malformedResponseError();
  }

  return {
    kind: "web_search",
    content: boundText(contentParts.join("\n\n"), MAX_SEARCH_CONTENT_LENGTH),
    sources: sources.length === 0 ? EMPTY_SOURCES : sources,
    citations: sources.length === 0 ? EMPTY_CITATIONS : sources.map((source) => source.url),
  };
}

function parseFetchResult(payload: Record<string, unknown>, requestedUrl: string): WebFetchResult {
  const results = payload.results;
  if (!Array.isArray(results) || results.length !== 1 || !isRecord(results[0])) {
    throw malformedResponseError();
  }

  const item = results[0];
  if (
    normalizePublicUrl(getString(item.url)) !== requestedUrl ||
    (item.id !== undefined && normalizePublicUrl(getString(item.id)) !== requestedUrl) ||
    !hasSuccessfulFetchStatus(payload.statuses, requestedUrl) ||
    typeof item.text !== "string"
  ) {
    throw malformedResponseError();
  }

  const rawText = item.text;
  const content = boundedText(rawText, MAX_FETCH_CONTENT_LENGTH);
  if (content === undefined) throw malformedResponseError();

  const title = boundedText(item.title, MAX_TITLE_LENGTH) ?? getDefaultTitle(requestedUrl);
  const source: WebSource = { title, url: requestedUrl };
  const publishedAt = boundedText(item.publishedDate, MAX_PUBLISHED_AT_LENGTH);
  if (publishedAt !== undefined) source.publishedAt = publishedAt;

  return {
    kind: "web_fetch",
    url: requestedUrl,
    title,
    content,
    sources: [source],
    citations: [requestedUrl],
    truncated: rawText.length > MAX_FETCH_CONTENT_LENGTH,
  };
}

function hasSuccessfulFetchStatus(value: unknown, requestedUrl: string): boolean {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) return false;

  const status = value[0];
  return status.status === "success" && normalizePublicUrl(getString(status.id)) === requestedUrl;
}

function parsePayload(value: unknown): Record<string, unknown> {
  try {
    if (typeof value === "string") {
      if (utf8ByteLengthUpTo(value, MAX_PROVIDER_BODY_BYTES) > MAX_PROVIDER_BODY_BYTES) {
        throw malformedResponseError();
      }
      value = JSON.parse(value) as unknown;
    }
  } catch (error) {
    if (error instanceof WebProviderError) throw error;
    throw malformedResponseError();
  }

  if (!isRecord(value)) throw malformedResponseError();
  return value;
}

/** Exa documents `x-api-key` for Search while Contents uses the shared
 * `Authorization: Bearer` form. Keep the Search-only translation here so the
 * shared HTTP deadline and error policy stay unchanged.
 */
function withExaSearchAuthentication(
  transport: WebProviderTransport,
  apiKey: string
): WebProviderTransport {
  return async (request) =>
    transport({
      ...request,
      headers: { "x-api-key": apiKey },
    });
}

function getSearchSnippet(value: unknown): string | undefined {
  if (typeof value === "string") return boundedText(value, MAX_SEARCH_SNIPPET_LENGTH);
  if (!Array.isArray(value)) return undefined;

  const highlights: string[] = [];
  for (let index = 0; index < value.length && index < MAX_HIGHLIGHTS; index += 1) {
    const highlight = boundedText(value[index], MAX_SEARCH_SNIPPET_LENGTH);
    if (highlight !== undefined) highlights.push(highlight);
  }
  return boundedText(highlights.join("\n"), MAX_SEARCH_SNIPPET_LENGTH);
}

function formatSearchSource(source: WebSource): string {
  return [source.title, source.url, source.snippet].filter(isString).join("\n");
}

function validateQuery(query: string): string {
  const normalizedQuery = typeof query === "string" ? query.trim() : "";
  if (!normalizedQuery || normalizedQuery.length > MAX_QUERY_LENGTH) {
    throw new WebProviderError("invalid_query", null, "The search query is invalid.", false);
  }
  return normalizedQuery;
}

function validateSearchLimit(limit: number | undefined): number {
  const normalizedLimit = limit ?? DEFAULT_SEARCH_LIMIT;
  if (
    !Number.isInteger(normalizedLimit) ||
    normalizedLimit < 1 ||
    normalizedLimit > MAX_SEARCH_LIMIT
  ) {
    throw new WebProviderError("invalid_query", null, "The search query is invalid.", false);
  }
  return normalizedLimit;
}

function validateApiKey(apiKey: string): void {
  if (
    apiKey.length < MIN_API_KEY_LENGTH ||
    apiKey.length > MAX_API_KEY_LENGTH ||
    /[^\x21-\x7e]/.test(apiKey)
  ) {
    throw new WebProviderError("invalid_credentials", null, "The Exa API key is invalid.", false);
  }
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

function boundText(value: string, maxLength: number): string {
  return value.slice(0, maxLength).replace(/\r\n?/g, "\n").split(String.fromCharCode(0)).join("");
}

function getDefaultTitle(url: string): string {
  return new URL(url).hostname;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidConfigurationError(): WebProviderError {
  return new WebProviderError(
    "invalid_configuration",
    null,
    "Exa provider configuration is invalid.",
    false
  );
}

function malformedResponseError(): WebProviderError {
  return new WebProviderError(
    "malformed_response",
    null,
    "Exa returned an invalid response.",
    false
  );
}
