import {
  resolveSourceInspectorTarget,
  type SourceReference,
  type WebSourceInspectorTarget,
} from "@/context/sourceReferences";
import { logError } from "@/logger";
import { normalizeUrlForMatching } from "@/utils/urlNormalization";
import { openSourceReference } from "@/utils/openSourceReference";
import { normalizePublicUrl } from "@/web/publicUrl";
import type { App } from "obsidian";
import React from "react";

const MAX_VISIBLE_SOURCES = 10;

interface ResolvedWebSource {
  source: SourceReference;
  target: WebSourceInspectorTarget;
  canonicalUrl: string;
}

const EMPTY_RESOLVED_SOURCES: readonly ResolvedWebSource[] = Object.freeze([]);

function getRenderableSources(sources: readonly SourceReference[]): readonly ResolvedWebSource[] {
  const seenUrls = new Set<string>();
  const deduplicated: ResolvedWebSource[] = [];

  for (const source of sources) {
    const target = resolveSourceInspectorTarget(source);
    if (!target || target.kind !== "web") continue;
    const publicUrl = normalizePublicUrl(target.url);
    if (!publicUrl) continue;

    const canonicalUrl = normalizeUrlForMatching(publicUrl);
    if (!canonicalUrl || seenUrls.has(canonicalUrl)) continue;

    seenUrls.add(canonicalUrl);
    deduplicated.push({ source, target: { kind: "web", url: publicUrl }, canonicalUrl });
  }

  if (deduplicated.length === 0) return EMPTY_RESOLVED_SOURCES;
  return deduplicated.slice(0, MAX_VISIBLE_SOURCES);
}

export interface AgentSourceListProps {
  /** Obsidian app used by the Source Inspector opener. */
  app: App;
  /** Persisted or live citation references in their display order. */
  sources: readonly SourceReference[];
}

/** Render safe, deduplicated web citations for an Agent Mode response. */
export const AgentSourceList: React.FC<AgentSourceListProps> = ({ app, sources }) => {
  const renderableSources = getRenderableSources(sources);
  if (renderableSources.length === 0) return null;

  return (
    <div data-agent-source-list className="tw-flex tw-flex-col tw-gap-1 tw-text-xs">
      <span className="tw-text-muted">Sources</span>
      {renderableSources.map(({ source, target, canonicalUrl }) => (
        <a
          key={canonicalUrl}
          href={target.url}
          target="_blank"
          rel="noopener noreferrer"
          className="tw-truncate tw-text-accent hover:tw-underline"
          aria-label={`Open source: ${source.title}`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void openSourceReference(app, source).catch(logError);
          }}
        >
          {source.title}
        </a>
      ))}
    </div>
  );
};
