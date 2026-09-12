import type {
  WebProvider,
  WebProviderTransport,
  WebFetchOptions,
  WebSearchOptions,
  WebSearchResult,
  WebFetchResult,
  WebSource,
} from "@/web/types";
import { WebProviderError } from "@/web/types";
import {
  defaultWebTransport,
  requestWebProvider,
  ensureSuccessfulResponse,
  utf8ByteLengthUpTo,
} from "@/web/providerHttp";
import { validatePublicUrl, normalizePublicUrl } from "@/web/publicUrl";

export { WebProviderError };

const FIRECRAWL_SEARCH_ENDPOINT = "https://api.firecrawl.dev/v2/search";
const FIRECRAWL_SCRAPE_ENDPOINT = "https://api.firecrawl.dev/v2/scrape";
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;
const MAX_QUERY_LENGTH = 512;
const MIN_API_KEY_LENGTH = 8;
const MAX_API_KEY_LENGTH = 256;
const MAX_TITLE_LENGTH = 300;
const MAX_SNIPPET_LENGTH = 2000;
const MAX_PUBLISHED_AT_LENGTH = 128;
const MAX_SEARCH_ITEM_CONTENT_LENGTH = 8000;
const MAX_SEARCH_CONTENT_LENGTH = 50000;
const MAX_FETCH_CONTENT_LENGTH = 100000;
const MAX_NORMALIZATION_LOOKAHEAD = 4096;
const MAX_CITATIONS = 50;
const MAX_SEARCH_ITEMS = 1000;
const MAX_FETCH_LINKS = 200;
const MAX_PROVIDER_BODY_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 30000;
const CONNECTION_QUERY = "Firecrawl";

const EMPTY_SOURCES: WebSource[] = Object.freeze([]) as unknown as WebSource[];
const EMPTY_CITATIONS: string[] = Object.freeze([]) as unknown as string[];
/**
 * Optional transport override for deterministic tests or a future host adapter.
 */
export interface CreateFirecrawlWebProviderOptions {
  apiKey: string;
  transport?: WebProviderTransport;
}

/**
 * Creates a settings-free provider for Firecrawl's fixed public API.
 *
 * The provider accepts only public web URLs and sends only the query or URL
 * needed by the selected operation. It deliberately owns no settings,
 * keychain, vault, prompt, or fallback behavior.
 *
 * @param options The API key and optional test transport for Firecrawl calls.
 */
export function createFirecrawlWebProvider(
  options: CreateFirecrawlWebProviderOptions
): WebProvider {
  if (!isRecord(options) || typeof options.apiKey !== "string") {
    throw invalidConfigurationError();
  }
  validateApiKey(options.apiKey);

  if (options.transport !== undefined && typeof options.transport !== "function") {
    throw invalidConfigurationError();
  }

  const transport = options.transport ?? defaultWebTransport;

  return {
    search: (query, searchOptions) =>
      searchWithFirecrawl(transport, options.apiKey, query, searchOptions),
    fetch: (url, fetchOptions) => fetchWithFirecrawl(transport, options.apiKey, url, fetchOptions),
    testConnection: () => testFirecrawlConnection(transport, options.apiKey),
  };
}

async function searchWithFirecrawl(
  transport: WebProviderTransport,
  apiKey: string,
  query: string,
  options?: WebSearchOptions
): Promise<WebSearchResult> {
  const normalizedQuery = validateQuery(query);
  const limit = validateSearchLimit(options?.limit);
  const response = await requestWebProvider(
    "Firecrawl",
    transport,
    apiKey,
    FIRECRAWL_SEARCH_ENDPOINT,
    {
      query: normalizedQuery,
      limit,
      sources: ["web"],
      timeout: REQUEST_TIMEOUT_MS,
    },
    options?.signal
  );

  ensureSuccessfulResponse(response, "Firecrawl");
  return parseSearchResult(response.json, limit);
}

async function fetchWithFirecrawl(
  transport: WebProviderTransport,
  apiKey: string,
  url: string,
  options?: WebFetchOptions
): Promise<WebFetchResult> {
  const normalizedUrl = validatePublicUrl(url);
  const response = await requestWebProvider(
    "Firecrawl",
    transport,
    apiKey,
    FIRECRAWL_SCRAPE_ENDPOINT,
    {
      url: normalizedUrl,
      formats: ["markdown"],
      onlyMainContent: true,
      removeBase64Images: true,
      blockAds: true,
      timeout: REQUEST_TIMEOUT_MS,
    },
    options?.signal
  );

  ensureSuccessfulResponse(response, "Firecrawl");
  return parseFetchResult(response.json, normalizedUrl);
}

async function testFirecrawlConnection(
  transport: WebProviderTransport,
  apiKey: string
): Promise<void> {
  const response = await requestWebProvider(
    "Firecrawl",
    transport,
    apiKey,
    FIRECRAWL_SEARCH_ENDPOINT,
    {
      query: CONNECTION_QUERY,
      limit: 1,
      sources: ["web"],
      timeout: REQUEST_TIMEOUT_MS,
    }
  );

  ensureSuccessfulResponse(response, "Firecrawl");
  parseSearchResult(response.json, 1);
}

function parseSearchResult(value: unknown, limit: number): WebSearchResult {
  const payload = parseSuccessEnvelope(value);
  const data = payload.data;
  const web = Array.isArray(data) ? data : isRecord(data) ? data.web : undefined;
  if (!Array.isArray(web)) {
    throw malformedResponseError();
  }
  if (web.length > MAX_SEARCH_ITEMS) throw malformedResponseError();

  const sources: WebSource[] = [];
  const contentParts: string[] = [];
  for (let index = 0; index < web.length; index += 1) {
    if (sources.length >= limit) break;
    const item = web[index];
    if (!isRecord(item)) continue;

    const sourceUrl = normalizePublicUrl(getString(item.url));
    if (sourceUrl === undefined) continue;

    const metadata = getRecord(item.metadata);
    const title =
      getBoundedString(item.title, MAX_TITLE_LENGTH) ??
      getBoundedString(metadata?.title, MAX_TITLE_LENGTH) ??
      getDefaultTitle(sourceUrl);
    const description = getBoundedString(item.description, MAX_SNIPPET_LENGTH);
    const markdown = getBoundedString(item.markdown, MAX_SEARCH_ITEM_CONTENT_LENGTH);
    const snippet = description ?? markdown;
    const publishedAt = getPublishedAt(item, metadata);
    const source: WebSource = { title, url: sourceUrl };
    if (snippet !== undefined) source.snippet = snippet;
    if (publishedAt !== undefined) source.publishedAt = publishedAt;

    sources.push(source);
    contentParts.push(formatSearchItem(source, markdown ?? description));
  }

  if (web.length > 0 && sources.length === 0) {
    throw malformedResponseError();
  }

  const content = boundText(contentParts.join("\n\n"), MAX_SEARCH_CONTENT_LENGTH);
  return {
    kind: "web_search",
    content,
    sources: sources.length === 0 ? EMPTY_SOURCES : sources,
    citations: sources.length === 0 ? EMPTY_CITATIONS : sources.map((source) => source.url),
  };
}

function parseFetchResult(value: unknown, requestedUrl: string): WebFetchResult {
  const payload = parseSuccessEnvelope(value);
  const data = payload.data;
  if (!isRecord(data)) throw malformedResponseError();
  const markdown = data.markdown;
  if (typeof markdown !== "string") {
    throw malformedResponseError();
  }

  const metadata = getRecord(data.metadata);
  const title =
    getBoundedString(data.title, MAX_TITLE_LENGTH) ??
    getBoundedString(metadata?.title, MAX_TITLE_LENGTH);
  const snippet = getBoundedString(metadata?.description, MAX_SNIPPET_LENGTH);
  const publishedAt = getPublishedAt(data, metadata);
  const source: WebSource = {
    title: title ?? getDefaultTitle(requestedUrl),
    url: requestedUrl,
  };
  if (snippet !== undefined) source.snippet = snippet;
  if (publishedAt !== undefined) source.publishedAt = publishedAt;

  const links = data.links;
  if (links !== undefined && !Array.isArray(links)) {
    throw malformedResponseError();
  }
  if (Array.isArray(links) && links.length > MAX_FETCH_LINKS) {
    throw malformedResponseError();
  }

  const citations = uniquePublicUrls([requestedUrl, ...(Array.isArray(links) ? links : [])]);
  const contentInput = markdown.slice(0, MAX_FETCH_CONTENT_LENGTH + MAX_NORMALIZATION_LOOKAHEAD);
  const normalizedContent = normalizeText(contentInput);
  return {
    kind: "web_fetch",
    url: requestedUrl,
    ...(title !== undefined && { title }),
    content: normalizedContent.slice(0, MAX_FETCH_CONTENT_LENGTH),
    sources: [source],
    citations,
    truncated: markdown.length > MAX_FETCH_CONTENT_LENGTH,
  };
}

function parseSuccessEnvelope(value: unknown): { data: unknown } {
  const parsed = parseJsonValue(value);
  if (
    !isRecord(parsed) ||
    parsed.success !== true ||
    !Object.prototype.hasOwnProperty.call(parsed, "data")
  ) {
    throw malformedResponseError();
  }
  return { data: parsed.data };
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (utf8ByteLengthUpTo(value, MAX_PROVIDER_BODY_BYTES) > MAX_PROVIDER_BODY_BYTES) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function validateApiKey(apiKey: string): void {
  if (
    apiKey.length < MIN_API_KEY_LENGTH ||
    apiKey.length > MAX_API_KEY_LENGTH ||
    apiKey !== apiKey.trim() ||
    /[^\x21-\x7e]/.test(apiKey)
  ) {
    throw new WebProviderError(
      "invalid_credentials",
      null,
      "The Firecrawl API key is invalid.",
      false
    );
  }
}

function validateQuery(query: string): string {
  if (typeof query !== "string") {
    throw invalidQueryError();
  }
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0 || normalizedQuery.length > MAX_QUERY_LENGTH) {
    throw invalidQueryError();
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
    throw invalidQueryError();
  }
  return normalizedLimit;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function getBoundedString(value: unknown, maxLength: number): string | undefined {
  const stringValue = getString(value);
  if (stringValue === undefined) return undefined;
  const normalized = normalizeText(stringValue.slice(0, maxLength));
  return normalized.length > 0 ? normalized.slice(0, maxLength) : undefined;
}

function getPublishedAt(
  value: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined
): string | undefined {
  return (
    getBoundedString(value.publishedAt, MAX_PUBLISHED_AT_LENGTH) ??
    getBoundedString(value.publishedDate, MAX_PUBLISHED_AT_LENGTH) ??
    getBoundedString(metadata?.publishedAt, MAX_PUBLISHED_AT_LENGTH) ??
    getBoundedString(metadata?.publishedDate, MAX_PUBLISHED_AT_LENGTH)
  );
}

function formatSearchItem(source: WebSource, content: string | undefined): string {
  if (content === undefined) return `${source.title}\n${source.url}`;
  return `${source.title}\n${source.url}\n${boundText(content, MAX_SEARCH_ITEM_CONTENT_LENGTH)}`;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").split(String.fromCharCode(0)).join("").trim();
}

function boundText(value: string, maxLength: number): string {
  return normalizeText(value.slice(0, maxLength)).slice(0, maxLength);
}

function uniquePublicUrls(values: unknown[]): string[] {
  const citations: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = normalizePublicUrl(value);
    if (normalized === undefined || seen.has(normalized)) continue;
    seen.add(normalized);
    citations.push(normalized);
    if (citations.length >= MAX_CITATIONS) break;
  }
  return citations.length === 0 ? EMPTY_CITATIONS : citations;
}

function getHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "Web source";
  }
}

function getDefaultTitle(url: string): string {
  return getBoundedString(getHostname(url), MAX_TITLE_LENGTH) ?? "Web source";
}

function invalidConfigurationError(): WebProviderError {
  return new WebProviderError(
    "invalid_configuration",
    null,
    "Firecrawl provider configuration is invalid.",
    false
  );
}

function invalidQueryError(): WebProviderError {
  return new WebProviderError("invalid_query", null, "The search query is invalid.", false);
}

function malformedResponseError(): WebProviderError {
  return new WebProviderError(
    "malformed_response",
    null,
    "Firecrawl returned an invalid response.",
    false
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
