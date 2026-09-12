import { toWebSourceReference, type SourceReference } from "@/context/sourceReferences";
import type { ToolCallContent } from "@/agentMode/session/types";

const WEB_BRIDGE_SERVER = "copilot-web";
const MAX_WEB_SOURCE_REFERENCES = 10;

/**
 * Extract citation metadata from the plugin-owned MCP web bridge output.
 * Parsing is deliberately gated by the server name; an arbitrary MCP tool's
 * JSON must not become a clickable browser link by merely containing a
 * `kind: "web_search"` field.
 */
export function extractAgentWebSourceReferences(
  mcpServer: string | undefined,
  content: readonly ToolCallContent[] | null | undefined
): SourceReference[] | undefined {
  if (mcpServer !== WEB_BRIDGE_SERVER || !content) return undefined;

  const references: SourceReference[] = [];
  const seenUrls = new Set<string>();
  for (const item of content) {
    if (item.type !== "content" || item.content.type !== "text") continue;
    const payload = parseWebResult(item.content.text);
    if (!payload) continue;

    const referencesBeforePayload = references.length;
    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    for (const source of sources) {
      const reference = toWebSourceReference(source);
      const url = reference?.url;
      if (!reference || !url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      references.push(reference);
      if (references.length >= MAX_WEB_SOURCE_REFERENCES) return references;
    }

    // A fetch response is allowed to carry only its requested URL. Preserve
    // that source even if a provider omitted the redundant `sources` array.
    if (references.length === referencesBeforePayload && payload.kind === "web_fetch") {
      const fallback = toWebSourceReference({
        title:
          typeof payload.title === "string" && payload.title.length > 0
            ? payload.title
            : safeHostname(payload.url),
        url: payload.url,
      });
      const url = fallback?.url;
      if (fallback && url && !seenUrls.has(url)) {
        seenUrls.add(url);
        references.push(fallback);
      }
    }
  }

  return references.length > 0 ? references : undefined;
}

interface WebResultPayload {
  kind: "web_search" | "web_fetch";
  sources?: unknown[];
  url?: unknown;
  title?: unknown;
}

function parseWebResult(value: string): WebResultPayload | null {
  if (value.length === 0 || value.length > 300_000) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return null;
    if (parsed.kind !== "web_search" && parsed.kind !== "web_fetch") return null;
    return parsed as unknown as WebResultPayload;
  } catch {
    return null;
  }
}

function safeHostname(value: unknown): string {
  if (typeof value !== "string") return "Web source";
  try {
    return new URL(value).hostname || "Web source";
  } catch {
    return "Web source";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
