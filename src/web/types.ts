/**
 * Providers currently supported by the independent web boundary.
 */
export type WebProviderId = "firecrawl" | "tavily" | "exa" | "custom";

/**
 * A citation-ready web source returned by a provider.
 */
export interface WebSource {
  title: string;
  url: string;
  snippet?: string;
  publishedAt?: string;
}

/**
 * Normalized result for a web search operation.
 */
export interface WebSearchResult {
  kind: "web_search";
  content: string;
  sources: WebSource[];
  citations: string[];
}

/**
 * Normalized result for fetching one public web URL.
 */
export interface WebFetchResult {
  kind: "web_fetch";
  url: string;
  title?: string;
  content: string;
  sources: WebSource[];
  citations: string[];
  truncated: boolean;
}

/**
 * Optional bounds for a web search request.
 */
export interface WebSearchOptions {
  limit?: number;
  /** Optional cooperative cancellation for hosts that support it. */
  signal?: AbortSignal;
}

/** Optional cooperative cancellation for a web fetch. */
export interface WebFetchOptions {
  signal?: AbortSignal;
}

/**
 * Public, settings-free web provider surface used by the future agent wiring.
 */
export interface WebProvider {
  search(query: string, options?: WebSearchOptions): Promise<WebSearchResult>;
  fetch(url: string, options?: WebFetchOptions): Promise<WebFetchResult>;
  testConnection(): Promise<void>;
}

/**
 * Stable categories for failures that can be shown without exposing provider
 * response bodies, request URLs, or credentials.
 */
export type WebProviderErrorCode =
  | "invalid_credentials"
  | "invalid_query"
  | "invalid_url"
  | "invalid_configuration"
  | "unauthorized"
  | "rate_limited"
  | "quota_exceeded"
  | "bad_request"
  | "timeout"
  | "server"
  | "network"
  | "malformed_response";

/**
 * Sanitized provider failure with enough structure for callers to choose a
 * user-facing action without seeing provider or transport details.
 */
export class WebProviderError extends Error {
  /**
   * @param code The stable failure category.
   * @param status The HTTP status, or null when no response was received.
   * @param message The sanitized message safe to show to a user.
   * @param retryable Whether a later user-initiated retry may be useful.
   */
  constructor(
    public readonly code: WebProviderErrorCode,
    public readonly status: number | null,
    message: string,
    public readonly retryable: boolean
  ) {
    super(message);
    this.name = "WebProviderError";
    Object.setPrototypeOf(this, WebProviderError.prototype);
  }
}

/**
 * Request passed to an injected provider transport.
 *
 * `timeoutMs` describes the caller's deadline. Obsidian's requestUrl transport
 * cannot cancel an accepted request, but keeping the deadline in the seam
 * lets tests and alternate transports observe the same contract.
 */
export interface WebProviderTransportRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  contentType: "application/json";
  body: string;
  timeoutMs: number;
  /** Optional cooperative cancellation for transports that can honor it. */
  signal?: AbortSignal;
}

/**
 * Minimal response shape needed by the provider boundary.
 */
export interface WebProviderTransportResponse {
  status: number;
  json: unknown;
  /** Raw response representations, when the host exposes them before JSON access. */
  text?: string;
  arrayBuffer?: ArrayBuffer;
}

/**
 * Injectable HTTP boundary for deterministic provider tests.
 */
export type WebProviderTransport = (
  request: WebProviderTransportRequest
) => Promise<WebProviderTransportResponse>;
