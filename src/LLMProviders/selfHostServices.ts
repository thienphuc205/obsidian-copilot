/** Transcript response shape returned by the self-host YouTube provider. */
export interface Youtube4llmResponse {
  response: {
    transcript: string;
  };
  elapsed_time_ms: number;
}
import { logError, logInfo } from "@/logger";
import { isSelfHostModeEnabled } from "./selfHostMode";
import { getSettings } from "@/settings/model";
import { safeFetchNoThrow } from "@/utils";
import { requireNodeModule } from "@/utils/desktopRuntime";

const FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v2/search";
const PERPLEXITY_CHAT_URL = "https://api.perplexity.ai/chat/completions";
const PARALLEL_SEARCH_URL = "https://api.parallel.ai/v1/search";
const PARALLEL_SEARCH_QUERY_MAX_LENGTH = 200;
const PARALLEL_OBJECTIVE_MAX_LENGTH = 5000;
const EXA_SEARCH_URL = "https://api.exa.ai/search";
const SUPADATA_TRANSCRIPT_URL = "https://api.supadata.ai/v1/transcript";
/** Bounds agent-controlled input. https://github.com/Brevilabs/obsidian-copilot-private/issues/165 */
const AGENT_REQUEST_MAX_LENGTH = 64 * 1024;

type HttpServer = import("node:http").Server;
type IncomingMessage = import("node:http").IncomingMessage;
type ServerResponse = import("node:http").ServerResponse;

/** Poll interval for Supadata async jobs (ms) */
const SUPADATA_POLL_INTERVAL = 2000;
/** Maximum time to wait for a Supadata async job (ms) */
const SUPADATA_POLL_TIMEOUT = 60000;

/** Clean web search result — no legacy Perplexity wrapper */
export interface SelfHostWebSearchResult {
  content: string;
  citations: string[];
}

/** Address and bearer token for one plugin-owned Agent Chat skill channel. */
export interface SelfHostWebSearchAgentChannel {
  /** Loopback search endpoint. Kept as the primary field for the existing env contract. */
  url: string;
  /** Loopback YouTube transcript endpoint. */
  youtubeUrl: string;
  token: string;
  /** Alias of `url` so the original search-only contract keeps compiling. */
  searchUrl: string;
}

/** Owns the provider-credential-free local channel used by Agent Chat search scripts. */
export interface SelfHostWebSearchAgentBridge {
  getChannel(): Promise<Readonly<SelfHostWebSearchAgentChannel>>;
  dispose(): void;
}

/**
 * Owns the provider-credential-free local channel used by Agent Chat skill
 * scripts: `/search` for web search and `/youtube` for YouTube transcripts.
 *
 * @param isModeValid Resolves the live, verified self-host entitlement state.
 * @param hasSearchKey Resolves whether the selected provider has a credential.
 * @param search Runs the configured provider search inside Obsidian.
 * @param hasYoutubeKey Resolves whether the Supadata credential is configured.
 * @param youtube Fetches the YouTube transcript inside Obsidian.
 */
export function createSelfHostWebSearchAgentBridge(
  isModeValid: () => boolean = isSelfHostModeEnabled,
  hasSearchKey: () => boolean = hasSelfHostSearchKey,
  search: (query: string) => Promise<SelfHostWebSearchResult> = selfHostWebSearch,
  hasYoutubeKey: () => boolean = hasSelfHostYoutubeKey,
  youtube: (url: string) => Promise<Youtube4llmResponse> = selfHostYoutube4llm
): Readonly<SelfHostWebSearchAgentBridge> {
  let server: HttpServer | null = null;
  let channelPromise: Promise<Readonly<SelfHostWebSearchAgentChannel>> | null = null;
  let rejectChannelStart: ((error: Error) => void) | null = null;
  let disposed = false;

  const runSearch = async (query: string): Promise<SelfHostWebSearchResult> => {
    // Agent processes must fail closed instead of falling back to a native
    // web tool when the signed self-host entitlement is unavailable.
    // https://github.com/Brevilabs/obsidian-copilot-private/issues/165
    if (!isModeValid()) {
      throw new Error("Self-host web search is not available for this session.");
    }
    if (!hasSearchKey()) {
      throw new Error("Add an API key for the selected self-host search provider.");
    }
    return search(query);
  };

  const runYoutube = async (url: string): Promise<Youtube4llmResponse> => {
    // Same fail-closed gate as search: without the Supadata credential the
    // transcript request would otherwise leak into an unauthenticated provider
    // call or fall back to an agent-native fetch of the video page.
    if (!isModeValid()) {
      throw new Error("Self-host YouTube transcripts are not available for this session.");
    }
    if (!hasYoutubeKey()) {
      throw new Error("Add a Supadata API key in Copilot settings to fetch YouTube transcripts.");
    }
    return youtube(url);
  };

  const startChannel = (): Promise<Readonly<SelfHostWebSearchAgentChannel>> => {
    const http = requireNodeModule<typeof import("node:http")>("http");
    const crypto = requireNodeModule<typeof import("node:crypto")>("crypto");
    const token = crypto.randomBytes(32).toString("hex");

    return new Promise((resolve, reject) => {
      let settled = false;
      const rejectStart = (error: Error): void => {
        if (settled) return;
        settled = true;
        rejectChannelStart = null;
        reject(error);
      };
      const resolveStart = (channel: Readonly<SelfHostWebSearchAgentChannel>): void => {
        if (settled) return;
        settled = true;
        rejectChannelStart = null;
        resolve(channel);
      };
      rejectChannelStart = rejectStart;
      const nextServer = http.createServer((request, response) => {
        void handleAgentSkillRequest(request, response, token, runSearch, runYoutube);
      });
      server = nextServer;
      nextServer.once("error", rejectStart);
      nextServer.listen(0, "127.0.0.1", () => {
        if (disposed) {
          nextServer.close();
          rejectStart(new Error("Self-host web search channel is closed."));
          return;
        }
        const address = nextServer.address() as import("node:net").AddressInfo;
        nextServer.on("error", (error) => {
          logError("[AgentMode] Self-host skill channel failed", error);
        });
        nextServer.unref();
        resolveStart(
          Object.freeze({
            url: `http://127.0.0.1:${address.port}/search`,
            searchUrl: `http://127.0.0.1:${address.port}/search`,
            youtubeUrl: `http://127.0.0.1:${address.port}/youtube`,
            token,
          })
        );
      });
    });
  };

  return Object.freeze({
    getChannel(): Promise<Readonly<SelfHostWebSearchAgentChannel>> {
      if (disposed) {
        return Promise.reject(new Error("Self-host web search channel is closed."));
      }
      channelPromise ??= startChannel();
      return channelPromise;
    },
    dispose(): void {
      disposed = true;
      // Closing before Node emits `listening` skips the listen callback, so
      // explicitly settle a spawn already awaiting this channel.
      // https://github.com/Brevilabs/obsidian-copilot-private/issues/165
      rejectChannelStart?.(new Error("Self-host web search channel is closed."));
      server?.close();
      server = null;
      channelPromise = null;
    },
  });
}

type AgentSkillHandler<Body> = (input: string) => Promise<Body>;

/**
 * Shared guard chain for both loopback skill routes. Binds to loopback, requires
 * the per-lifecycle token, and accepts only the two known routes so another
 * vault or local webpage cannot select this plugin instance.
 * https://github.com/Brevilabs/obsidian-copilot-private/issues/165
 */
async function handleAgentSkillRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  search: AgentSkillHandler<SelfHostWebSearchResult>,
  youtube: AgentSkillHandler<Youtube4llmResponse>
): Promise<void> {
  const route = request.method === "POST" ? (request.url ?? "") : "";
  if (route !== "/search" && route !== "/youtube") {
    writeAgentSkillResponse(response, 404, { error: "Not found." });
    return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    writeAgentSkillResponse(response, 401, { error: "Unauthorized." });
    return;
  }

  try {
    const body = await readAgentSkillRequestBody(request);
    if (route === "/search") {
      if (!body.trim()) {
        writeAgentSkillResponse(response, 400, { error: "A non-empty query is required." });
        return;
      }
      writeAgentSkillResponse(response, 200, await search(body));
      return;
    }
    let parsedUrl: unknown;
    try {
      parsedUrl = JSON.parse(body);
    } catch {
      parsedUrl = undefined;
    }
    const url =
      typeof parsedUrl === "object" &&
      parsedUrl !== null &&
      typeof (parsedUrl as { url?: unknown }).url === "string"
        ? (parsedUrl as { url: string }).url
        : "";
    if (!url.trim()) {
      writeAgentSkillResponse(response, 400, { error: "A non-empty url is required." });
      return;
    }
    writeAgentSkillResponse(response, 200, await youtube(url));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === "Request body is too large." ? 413 : 500;
    writeAgentSkillResponse(response, status, { error: message });
  }
}

async function readAgentSkillRequestBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > AGENT_REQUEST_MAX_LENGTH) {
      throw new Error("Request body is too large.");
    }
  }
  return body;
}

function writeAgentSkillResponse(
  response: ServerResponse,
  status: number,
  body: SelfHostWebSearchResult | Youtube4llmResponse | { error: string }
): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

interface FirecrawlSearchResult {
  title?: string;
  description?: string;
  url?: string;
}

type SearchSnippetField = "excerpts" | "highlights";

/**
 * One provider result row with provenance. Auto mode merges these across
 * providers; single-provider mode renders them straight into the channel's
 * `{ content, citations }` shape, which stays unchanged on the wire.
 */
interface SelfHostSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  provider: string;
}

/** Render result rows into the channel's `{ content, citations }` response shape. */
function renderResultItems(items: SelfHostSearchResultItem[]): SelfHostWebSearchResult {
  const contentParts: string[] = [];
  const citations: string[] = [];

  for (const item of items) {
    const content = [`### ${item.title}`, item.snippet, item.url ? `Source: ${item.url}` : ""]
      .filter(Boolean)
      .join("\n");

    contentParts.push(content);
    if (item.url) {
      citations.push(item.url);
    }
  }

  return { content: contentParts.join("\n\n"), citations };
}

/**
 * Normalize ranked provider results into rows without treating missing or
 * malformed URLs as citations. https://github.com/Brevilabs/obsidian-copilot-private/issues/285
 */
function normalizeProviderResultItems(
  rawResults: unknown,
  snippetField: SearchSnippetField,
  provider: string
): SelfHostSearchResultItem[] {
  if (!Array.isArray(rawResults)) {
    return [];
  }

  const items: SelfHostSearchResultItem[] = [];

  for (const item of rawResults) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }

    const record = item as Record<string, unknown>;
    const title =
      typeof record.title === "string" && record.title.trim() ? record.title.trim() : "Untitled";
    const url = typeof record.url === "string" ? record.url.trim() : "";
    const snippets = Array.isArray(record[snippetField])
      ? record[snippetField].filter(
          (snippet): snippet is string => typeof snippet === "string" && snippet.trim().length > 0
        )
      : [];

    items.push({ title, url, snippet: snippets.join("\n"), provider });
  }

  return items;
}

/**
 * Check whether the currently selected self-host search provider has an API key configured.
 */
export function hasSelfHostSearchKey(): boolean {
  const settings = getSettings();
  switch (settings.selfHostSearchProvider) {
    // Auto merges every configured provider, so any one credential suffices.
    case "auto":
      return (
        !!settings.firecrawlApiKey ||
        !!settings.parallelApiKey ||
        !!settings.exaApiKey ||
        !!settings.perplexityApiKey
      );
    // Each self-host provider reads only its own credential.
    // https://github.com/Brevilabs/obsidian-copilot-private/issues/285
    case "parallel":
      return !!settings.parallelApiKey;
    case "exa":
      return !!settings.exaApiKey;
    case "perplexity":
      return !!settings.perplexityApiKey;
    case "firecrawl":
    default:
      return !!settings.firecrawlApiKey;
  }
}

/**
 * Whether the Supadata credential for YouTube transcripts is configured.
 * Distinct from the search keys: `/youtube` never accepts another provider's
 * credential.
 */
export function hasSelfHostYoutubeKey(): boolean {
  return !!getSettings().supadataApiKey;
}

/**
 * Web search via Firecrawl direct API (self-host mode).
 * Handles both v2 `data.web` format and older flat `data` array.
 */
async function firecrawlSearchRows(
  query: string,
  apiKey: string
): Promise<SelfHostSearchResultItem[]> {
  const startTime = Date.now();

  const response = await safeFetchNoThrow(FIRECRAWL_SEARCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, limit: 5 }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Firecrawl search failed (${response.status}): ${text}`);
  }

  const json = (await response.json()) as {
    data?: FirecrawlSearchResult[] | { web?: FirecrawlSearchResult[] };
  };

  // v2 returns { data: { web: [...] } }, older responses return { data: [...] }
  const rawData = json?.data;
  const results: FirecrawlSearchResult[] = Array.isArray(rawData)
    ? rawData
    : Array.isArray(rawData?.web)
      ? rawData.web
      : [];

  const elapsed = Date.now() - startTime;
  logInfo(`[selfHostWebSearch] Firecrawl: ${results.length} results in ${elapsed}ms`);

  return results.map((item) => ({
    title: item.title || "Untitled",
    url: item.url || "",
    snippet: item.description || "",
    provider: "firecrawl",
  }));
}

/** Web search via Perplexity Sonar API (self-host mode). */
async function perplexitySonarSearch(
  query: string,
  apiKey: string
): Promise<SelfHostWebSearchResult> {
  const response = await safeFetchNoThrow(PERPLEXITY_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar",
      messages: [{ role: "user", content: query }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Perplexity Sonar search failed (${response.status}): ${text}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    citations?: unknown;
  };
  const content = json?.choices?.[0]?.message?.content ?? "";
  const citations: string[] = Array.isArray(json?.citations) ? (json.citations as string[]) : [];

  return { content, citations };
}

/** Web search via Parallel's GA Search API (self-host mode). */
async function parallelSearchRows(
  query: string,
  apiKey: string
): Promise<SelfHostSearchResultItem[]> {
  // Parallel rejects requests above these per-field limits, so bound them only
  // at its API boundary. https://github.com/Brevilabs/obsidian-copilot-private/issues/285
  const response = await safeFetchNoThrow(PARALLEL_SEARCH_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      objective: query.slice(0, PARALLEL_OBJECTIVE_MAX_LENGTH),
      search_queries: [query.slice(0, PARALLEL_SEARCH_QUERY_MAX_LENGTH)],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Parallel search failed (${response.status}): ${text}`);
  }

  const json = (await response.json()) as { results?: unknown };
  return normalizeProviderResultItems(json?.results, "excerpts", "parallel");
}

/** Web search via Exa's Search API (self-host mode). */
async function exaSearchRows(query: string, apiKey: string): Promise<SelfHostSearchResultItem[]> {
  const response = await safeFetchNoThrow(EXA_SEARCH_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      numResults: 5,
      contents: { highlights: true },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Exa search failed (${response.status}): ${text}`);
  }

  const json = (await response.json()) as { results?: unknown };
  return normalizeProviderResultItems(json?.results, "highlights", "exa");
}

/** Single-provider cap auto merging matches: Firecrawl's `limit: 5`. */
const AUTO_MERGE_MAX_RESULTS = 5;

/**
 * Provider registry for auto mode: one entry per mergeable provider, paired
 * with the settings field holding its credential. Perplexity is normalized to
 * citation rows up front so every entry yields the same row shape.
 */
const AUTO_SEARCH_PROVIDERS: {
  name: "firecrawl" | "parallel" | "exa" | "perplexity";
  keyField: "firecrawlApiKey" | "parallelApiKey" | "exaApiKey" | "perplexityApiKey";
  search: (query: string, apiKey: string) => Promise<SelfHostSearchResultItem[]>;
}[] = [
  { name: "firecrawl", keyField: "firecrawlApiKey", search: firecrawlSearchRows },
  { name: "exa", keyField: "exaApiKey", search: exaSearchRows },
  {
    name: "perplexity",
    keyField: "perplexityApiKey",
    search: async (query, apiKey) =>
      perplexityResultItems(await perplexitySonarSearch(query, apiKey)),
  },
  { name: "parallel", keyField: "parallelApiKey", search: parallelSearchRows },
];

/** Strip query/hash and trailing slash so the same page from two providers dedupes. */
function normalizeUrlForDedupe(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Human-readable label for a citation URL (its host, or the index fallback). */
function citationTitle(url: string, index: number): string {
  try {
    return new URL(url).hostname || `Citation ${index + 1}`;
  } catch {
    return `Citation ${index + 1}`;
  }
}

/**
 * Query every provider that has a credential in parallel and merge their
 * results: URLs are deduped (longest snippet wins), rows interleave
 * round-robin so no single provider dominates, and a per-provider failure
 * never sinks the merge. https://github.com/Brevilabs/obsidian-copilot-private/issues/285
 */
async function autoMergeSearch(query: string): Promise<SelfHostWebSearchResult> {
  const settings = getSettings();
  const withKeys = AUTO_SEARCH_PROVIDERS.filter((p) => !!settings[p.keyField]);
  const hasOnlyPerplexity = withKeys.length === 1 && withKeys[0].name === "perplexity";

  if (withKeys.length === 0) {
    throw new Error(
      "Auto search needs at least one provider API key (Firecrawl, Parallel, Exa, or Perplexity)."
    );
  }
  // Perplexity synthesizes an answer instead of ranked sources, so its
  // citations alone would starve auto of real result rows.
  if (hasOnlyPerplexity) {
    throw new Error("Auto needs a results provider; Perplexity only synthesizes an answer.");
  }

  const settled = await Promise.allSettled(
    withKeys.map((p) => p.search(query, settings[p.keyField]))
  );

  const rowsByProvider = new Map<string, SelfHostSearchResultItem[]>();
  const failures: string[] = [];

  for (let i = 0; i < withKeys.length; i++) {
    const outcome = settled[i];
    const name = withKeys[i].name;

    if (outcome.status !== "fulfilled") {
      const reason =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      logError(`[selfHostWebSearch] auto: ${name} failed: ${reason}`);
      failures.push(`${name}: ${reason}`);
      continue;
    }

    // Perplexity is already normalized to citation rows by the registry.
    rowsByProvider.set(name, outcome.value);
  }

  if (rowsByProvider.size === 0) {
    throw new Error(`Auto search failed on every configured provider. ${failures.join(" | ")}`);
  }

  // Interleave in registry order (firecrawl, exa, perplexity, parallel) so
  // early slots mix providers, then cap to the count a single-provider search
  // returns today.
  const providerRows = AUTO_SEARCH_PROVIDERS.filter((p) => rowsByProvider.has(p.name)).map(
    (p) => rowsByProvider.get(p.name)!
  );

  const cursors: number[] = new Array(providerRows.length).fill(0);
  const merged: SelfHostSearchResultItem[] = [];
  // Dedupe key -> merged index; duplicate URLs keep the longest snippet.
  const seenUrls = new Map<string, { index: number; snippet: string }>();

  let exhausted = false;
  while (!exhausted && merged.length < AUTO_MERGE_MAX_RESULTS) {
    exhausted = true;
    for (let i = 0; i < providerRows.length; i++) {
      const rows = providerRows[i];
      // Advance past deduped/exhausted rows to this provider's next fresh one.
      while (cursors[i] < rows.length && merged.length < AUTO_MERGE_MAX_RESULTS) {
        const row = rows[cursors[i]];
        cursors[i] += 1;

        // Uncited rows carry no source to dedupe or attribute, so skip them.
        if (!row.url) {
          continue;
        }
        const key = normalizeUrlForDedupe(row.url);
        const existing = seenUrls.get(key);
        if (existing !== undefined) {
          // Same page from another provider: keep the first row's identity,
          // swap in the richer snippet.
          if (row.snippet.length > existing.snippet.length) {
            merged[existing.index].snippet = row.snippet;
            existing.snippet = row.snippet;
          }
          continue;
        }
        seenUrls.set(key, { index: merged.length, snippet: row.snippet });
        merged.push(row);
        break;
      }
      if (cursors[i] < rows.length) {
        exhausted = false;
      }
    }
  }

  const summary = AUTO_SEARCH_PROVIDERS.map(
    (p) => `${p.name}=${rowsByProvider.get(p.name)?.length ?? 0}`
  ).join(", ");
  logInfo(`[selfHostWebSearch] auto: ${summary} -> ${merged.length} merged results`);

  return {
    content: renderResultItems(merged).content,
    citations: merged.filter((r) => r.url).map((r) => r.url),
  };
}

/** Map Perplexity's synthesized answer to url-only rows (its prose is not a source). */
function perplexityResultItems(result: SelfHostWebSearchResult): SelfHostSearchResultItem[] {
  return result.citations.map((url, index) => ({
    title: citationTitle(url, index),
    url,
    snippet: "",
    provider: "perplexity",
  }));
}

/**
 * Dispatch self-host web search to the provider selected in settings.
 * Returns content + citations directly without the legacy Perplexity wrapper.
 */
export async function selfHostWebSearch(query: string): Promise<SelfHostWebSearchResult> {
  const settings = getSettings();
  switch (settings.selfHostSearchProvider) {
    case "auto":
      return autoMergeSearch(query);
    // Direct dispatch keeps hosted search unchanged and prevents credentials
    // crossing provider boundaries. https://github.com/Brevilabs/obsidian-copilot-private/issues/285
    case "parallel":
      return renderResultItems(await parallelSearchRows(query, settings.parallelApiKey));
    case "exa":
      return renderResultItems(await exaSearchRows(query, settings.exaApiKey));
    case "perplexity":
      return perplexitySonarSearch(query, settings.perplexityApiKey);
    case "firecrawl":
    default:
      return renderResultItems(await firecrawlSearchRows(query, settings.firecrawlApiKey));
  }
}

/**
 * YouTube transcript via Supadata direct API (self-host mode).
 * Returns the same Youtube4llmResponse shape as BrevilabsClient.youtube4llm().
 */
export async function selfHostYoutube4llm(url: string): Promise<Youtube4llmResponse> {
  const startTime = Date.now();
  const apiKey = getSettings().supadataApiKey;

  const transcriptUrl = `${SUPADATA_TRANSCRIPT_URL}?url=${encodeURIComponent(url)}&mode=auto&text=true`;

  const response = await safeFetchNoThrow(transcriptUrl, {
    method: "GET",
    headers: {
      "x-api-key": apiKey,
      Accept: "application/json",
    },
  });

  if (response.status === 200) {
    const json = (await response.json()) as { content?: string };
    const elapsed = Date.now() - startTime;
    logInfo(`[selfHostYoutube4llm] transcript received in ${elapsed}ms`);
    return {
      response: { transcript: json.content || "" },
      elapsed_time_ms: elapsed,
    };
  }

  if (response.status === 201 || response.status === 202) {
    const json = (await response.json()) as { job_id?: string };
    const jobId = json.job_id;
    if (!jobId) {
      throw new Error("Supadata returned async status but no job_id");
    }
    return await pollSupadataJob(jobId, apiKey, startTime);
  }

  const text = await response.text();
  throw new Error(`Supadata transcript request failed (${response.status}): ${text}`);
}

/**
 * Poll a Supadata async transcript job until it completes or times out.
 */
async function pollSupadataJob(
  jobId: string,
  apiKey: string,
  startTime: number
): Promise<Youtube4llmResponse> {
  const deadline = Date.now() + SUPADATA_POLL_TIMEOUT;
  const pollUrl = `${SUPADATA_TRANSCRIPT_URL}/${jobId}`;

  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, SUPADATA_POLL_INTERVAL));

    const pollResponse = await safeFetchNoThrow(pollUrl, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        Accept: "application/json",
      },
    });

    if (pollResponse.status === 200) {
      const json = (await pollResponse.json()) as { content?: string };
      const elapsed = Date.now() - startTime;
      logInfo(`[selfHostYoutube4llm] async transcript completed in ${elapsed}ms`);
      return {
        response: { transcript: json.content || "" },
        elapsed_time_ms: elapsed,
      };
    }

    if (pollResponse.status === 202) {
      continue;
    }

    const text = await pollResponse.text();
    logError(`[selfHostYoutube4llm] poll failed (${pollResponse.status}): ${text}`);
    throw new Error(`Supadata poll failed (${pollResponse.status}): ${text}`);
  }

  throw new Error(`Supadata transcript timed out after ${SUPADATA_POLL_TIMEOUT}ms`);
}
