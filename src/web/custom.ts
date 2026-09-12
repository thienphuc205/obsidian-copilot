import type {
  WebFetchOptions,
  WebFetchResult,
  WebProvider,
  WebProviderTransport,
  WebSearchOptions,
  WebSearchResult,
  WebSource,
} from "@/web/types";
import { WebProviderError } from "@/web/types";
import {
  defaultWebTransport,
  ensureSuccessfulResponse,
  requestWebProvider,
  utf8ByteLengthUpTo,
} from "@/web/providerHttp";
import { normalizePublicUrl, validatePublicUrl } from "@/web/publicUrl";

const PROVIDER_NAME = "Custom API";
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;
const MAX_QUERY_LENGTH = 512;
const MIN_API_KEY_LENGTH = 8;
const MAX_API_KEY_LENGTH = 256;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 300;
const MAX_SNIPPET_LENGTH = 2000;
const MAX_PUBLISHED_AT_LENGTH = 128;
const MAX_SEARCH_CONTENT_LENGTH = 50000;
const MAX_FETCH_CONTENT_LENGTH = 100000;
const MAX_SOURCES = 10;
const MAX_CITATIONS = 50;
const MAX_PROVIDER_BODY_BYTES = 512 * 1024;
const CONNECTION_QUERY = "connection test";

const EMPTY_SOURCES: WebSource[] = Object.freeze([]) as unknown as WebSource[];
const EMPTY_CITATIONS: string[] = Object.freeze([]) as unknown as string[];

/** Optional transport override for deterministic tests or a host-specific adapter. */
export interface CreateCustomWebProviderOptions {
  apiKey: string;
  baseUrl: string;
  transport?: WebProviderTransport;
}

/**
 * Creates a settings-free client for a user-owned normalized web API.
 *
 * The API receives only the explicit search query or public URL for each
 * operation. It owns neither settings, vault access, prompt context, nor
 * fallback behavior.
 *
 * @param options The API key, public HTTPS base URL, and optional test transport.
 */
export function createCustomWebProvider(options: CreateCustomWebProviderOptions): WebProvider {
  if (
    !isRecord(options) ||
    typeof options.apiKey !== "string" ||
    typeof options.baseUrl !== "string" ||
    (options.transport !== undefined && typeof options.transport !== "function")
  ) {
    throw invalidConfigurationError();
  }

  validateApiKey(options.apiKey);
  const baseUrl = validateBaseUrl(options.baseUrl);
  const transport = options.transport ?? defaultWebTransport;
  const searchEndpoint = `${baseUrl}/search`;
  const fetchEndpoint = `${baseUrl}/fetch`;

  return {
    search: (query, searchOptions) =>
      searchWithCustomApi(transport, options.apiKey, searchEndpoint, query, searchOptions),
    fetch: (url, fetchOptions) =>
      fetchWithCustomApi(transport, options.apiKey, fetchEndpoint, url, fetchOptions),
    testConnection: () => testCustomApiConnection(transport, options.apiKey, searchEndpoint),
  };
}

async function searchWithCustomApi(
  transport: WebProviderTransport,
  apiKey: string,
  endpoint: string,
  query: string,
  options?: WebSearchOptions
): Promise<WebSearchResult> {
  const normalizedQuery = validateQuery(query);
  const limit = validateSearchLimit(options?.limit);
  const response = await requestWebProvider(
    PROVIDER_NAME,
    transport,
    apiKey,
    endpoint,
    { query: normalizedQuery, limit },
    options?.signal
  );

  ensureSuccessfulResponse(response, PROVIDER_NAME);
  return parseSearchResult(readResponseJson(response), limit);
}

async function fetchWithCustomApi(
  transport: WebProviderTransport,
  apiKey: string,
  endpoint: string,
  url: string,
  options?: WebFetchOptions
): Promise<WebFetchResult> {
  const requestedUrl = validatePublicUrl(url);
  const response = await requestWebProvider(
    PROVIDER_NAME,
    transport,
    apiKey,
    endpoint,
    { url: requestedUrl },
    options?.signal
  );

  ensureSuccessfulResponse(response, PROVIDER_NAME);
  return parseFetchResult(readResponseJson(response), requestedUrl);
}

async function testCustomApiConnection(
  transport: WebProviderTransport,
  apiKey: string,
  endpoint: string
): Promise<void> {
  await searchWithCustomApi(transport, apiKey, endpoint, CONNECTION_QUERY, { limit: 1 });
}

function parseSearchResult(value: unknown, limit: number): WebSearchResult {
  const parsed = parseJsonValue(value);
  if (!isRecord(parsed) || parsed.kind !== "web_search") {
    throw malformedResponseError();
  }

  const content = boundedContent(parsed.content, MAX_SEARCH_CONTENT_LENGTH);
  if (content === undefined) throw malformedResponseError();

  const sources = normalizeSources(parsed.sources, limit);
  const citations = normalizeCitations(parsed.citations);
  return {
    kind: "web_search",
    content,
    sources,
    citations,
  };
}

function readResponseJson(response: { json: unknown }): unknown {
  try {
    return response.json;
  } catch {
    throw malformedResponseError();
  }
}

function parseFetchResult(value: unknown, requestedUrl: string): WebFetchResult {
  const parsed = parseJsonValue(value);
  if (!isRecord(parsed) || parsed.kind !== "web_fetch") {
    throw malformedResponseError();
  }

  const responseUrl = typeof parsed.url === "string" ? normalizePublicUrl(parsed.url) : undefined;
  if (responseUrl !== requestedUrl) throw malformedResponseError();

  const content = boundedContent(parsed.content, MAX_FETCH_CONTENT_LENGTH);
  if (content === undefined || typeof parsed.truncated !== "boolean") {
    throw malformedResponseError();
  }

  const title = optionalMetadata(parsed, "title", MAX_TITLE_LENGTH);
  const sources = normalizeSources(parsed.sources, MAX_SOURCES);
  const citations = normalizeCitations(parsed.citations);
  return {
    kind: "web_fetch",
    url: requestedUrl,
    ...(title === undefined ? {} : { title }),
    content,
    sources,
    citations,
    truncated: parsed.truncated,
  };
}

function normalizeSources(value: unknown, maximum: number): WebSource[] {
  if (!Array.isArray(value)) throw malformedResponseError();

  const sources: WebSource[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (sources.length >= Math.min(maximum, MAX_SOURCES)) break;
    if (!isRecord(item) || typeof item.url !== "string") {
      throw malformedResponseError();
    }

    const url = normalizePublicUrl(item.url);
    if (url === undefined || seen.has(url)) continue;

    const title = requiredMetadata(item.title, MAX_TITLE_LENGTH);
    const snippet = optionalMetadata(item, "snippet", MAX_SNIPPET_LENGTH);
    const publishedAt = optionalMetadata(item, "publishedAt", MAX_PUBLISHED_AT_LENGTH);
    seen.add(url);
    sources.push({
      title,
      url,
      ...(snippet === undefined ? {} : { snippet }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    });
  }

  return sources.length === 0 ? EMPTY_SOURCES : sources;
}

function normalizeCitations(value: unknown): string[] {
  if (!Array.isArray(value)) throw malformedResponseError();

  const citations: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (citations.length >= MAX_CITATIONS) break;
    if (typeof item !== "string") throw malformedResponseError();

    const url = normalizePublicUrl(item);
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);
    citations.push(url);
  }

  return citations.length === 0 ? EMPTY_CITATIONS : citations;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (utf8ByteLengthUpTo(value, MAX_PROVIDER_BODY_BYTES) > MAX_PROVIDER_BODY_BYTES) {
    throw malformedResponseError();
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw malformedResponseError();
  }
}

function boundedContent(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string" || value.length > maximum) return undefined;
  return normalizeText(value);
}

function requiredMetadata(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum) {
    throw malformedResponseError();
  }
  const normalized = normalizeText(value);
  if (normalized.length === 0) throw malformedResponseError();
  return normalized;
}

function optionalMetadata(
  record: Record<string, unknown>,
  key: string,
  maximum: number
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum) {
    throw malformedResponseError();
  }
  const normalized = normalizeText(value);
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").split(String.fromCharCode(0)).join("").trim();
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
      "The Custom API key is invalid.",
      false
    );
  }
}

function validateBaseUrl(baseUrl: string): string {
  if (
    baseUrl.length === 0 ||
    baseUrl.length > MAX_URL_LENGTH ||
    baseUrl !== baseUrl.trim() ||
    baseUrl.includes("?") ||
    baseUrl.includes("#")
  ) {
    throw invalidConfigurationError();
  }

  let normalizedUrl: string;
  try {
    normalizedUrl = validatePublicUrl(baseUrl);
  } catch {
    throw invalidConfigurationError();
  }

  let parsed: URL;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    throw invalidConfigurationError();
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw invalidConfigurationError();
  }

  return normalizedUrl.replace(/\/+$/, "");
}

function validateQuery(query: string): string {
  if (typeof query !== "string") throw invalidQueryError();
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

function invalidConfigurationError(): WebProviderError {
  return new WebProviderError(
    "invalid_configuration",
    null,
    "Custom API provider configuration is invalid.",
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
    "Custom API returned an invalid response.",
    false
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
