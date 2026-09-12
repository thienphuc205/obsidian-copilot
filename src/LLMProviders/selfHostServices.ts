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
 * Normalize ranked provider results without treating missing or malformed URLs
 * as citations. https://github.com/Brevilabs/obsidian-copilot-private/issues/285
 */
function normalizeProviderResults(
  rawResults: unknown,
  snippetField: SearchSnippetField
): SelfHostWebSearchResult {
  if (!Array.isArray(rawResults)) {
    return { content: "", citations: [] };
  }

  const contentParts: string[] = [];
  const citations: string[] = [];

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
    const content = [`### ${title}`, snippets.join("\n"), url ? `Source: ${url}` : ""]
      .filter(Boolean)
      .join("\n");

    contentParts.push(content);
    if (url) {
      citations.push(url);
    }
  }

  return { content: contentParts.join("\n\n"), citations };
}

/**
 * Check whether the currently selected self-host search provider has an API key configured.
 */
export function hasSelfHostSearchKey(): boolean {
  const settings = getSettings();
  switch (settings.selfHostSearchProvider) {
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
async function firecrawlSearch(query: string, apiKey: string): Promise<SelfHostWebSearchResult> {
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

  const contentParts: string[] = [];
  const citations: string[] = [];

  for (const item of results) {
    const title = item.title || "Untitled";
    const description = item.description || "";
    const url = item.url || "";
    contentParts.push(`### ${title}\n${description}\nSource: ${url}`);
    if (url) {
      citations.push(url);
    }
  }

  const elapsed = Date.now() - startTime;
  logInfo(`[selfHostWebSearch] Firecrawl: ${results.length} results in ${elapsed}ms`);

  return { content: contentParts.join("\n\n"), citations };
}

/**
 * Web search via Perplexity Sonar API (self-host mode).
 */
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
async function parallelSearch(query: string, apiKey: string): Promise<SelfHostWebSearchResult> {
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
  return normalizeProviderResults(json?.results, "excerpts");
}

/** Web search via Exa's Search API (self-host mode). */
async function exaSearch(query: string, apiKey: string): Promise<SelfHostWebSearchResult> {
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
  return normalizeProviderResults(json?.results, "highlights");
}

/**
 * Dispatch self-host web search to the provider selected in settings.
 * Returns content + citations directly without the legacy Perplexity wrapper.
 */
export async function selfHostWebSearch(query: string): Promise<SelfHostWebSearchResult> {
  const settings = getSettings();
  switch (settings.selfHostSearchProvider) {
    // Direct dispatch keeps hosted search unchanged and prevents credentials
    // crossing provider boundaries. https://github.com/Brevilabs/obsidian-copilot-private/issues/285
    case "parallel":
      return parallelSearch(query, settings.parallelApiKey);
    case "exa":
      return exaSearch(query, settings.exaApiKey);
    case "perplexity":
      return perplexitySonarSearch(query, settings.perplexityApiKey);
    case "firecrawl":
    default:
      return firecrawlSearch(query, settings.firecrawlApiKey);
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
