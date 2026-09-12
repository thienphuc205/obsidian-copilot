/**
 * Citation utilities for inline citation processing.
 * Handles the conversion of footnote-style citations into a renderable
 * Sources section used by the chat UI.
 */

// ===== CITATION PROCESSING UTILITIES =====

interface SourcesSection {
  mainContent: string;
  sourcesBlock: string;
}

/**
 * Extracts the sources section from content if present.
 * Tries multiple strategies in order:
 *   1. Explicit "Sources" heading (e.g. "#### Sources", "Sources:")
 *   2. Horizontal rule separator (---) followed by footnote definitions
 *   3. Trailing block of bare footnote definitions with no separator
 */
function extractSourcesSection(content: string): SourcesSection | null {
  // Strategy 1: Explicit "Sources" heading (original behavior)
  const sourcesRegex = /([\s\S]*?)\n+(?:####\s*)?Sources\s*:?\s*\n+([\s\S]*)$/i;
  const match = content.match(sourcesRegex);
  if (match) {
    return {
      mainContent: match[1],
      sourcesBlock: (match[2] || "").trim(),
    };
  }

  // Strategy 2: --- separator followed by footnote definitions only
  // All non-empty lines after the separator must be footnote definitions to avoid
  // treating a content-bearing --- divider as a sources boundary.
  const hrMatch = content.match(/([\s\S]*?)\n+---+\s*\n+([\s\S]*)$/);
  if (hrMatch) {
    const afterHr = (hrMatch[2] || "").trim();
    const allFootnotes =
      afterHr.length > 0 &&
      afterHr.split("\n").every((line) => !line.trim() || /^\[\^\d+\]:/.test(line.trim()));
    if (allFootnotes) {
      return {
        mainContent: hrMatch[1],
        sourcesBlock: afterHr,
      };
    }
  }

  // Strategy 3: Trailing block of bare footnote definitions (no separator)
  const trailingMatch = content.match(/([\s\S]*?)\n{2,}(\[\^\d+\]:[\s\S]*)$/);
  if (trailingMatch) {
    const footnotesBlock = (trailingMatch[2] || "").trim();
    const allFootnotes = footnotesBlock
      .split("\n")
      .every((line) => !line.trim() || /^\[\^\d+\]:/.test(line.trim()));
    if (allFootnotes) {
      return {
        mainContent: trailingMatch[1],
        sourcesBlock: footnotesBlock,
      };
    }
  }

  return null;
}

/**
 * Normalizes sources block by adding line breaks if everything is on one line.
 */
function normalizeSourcesBlock(sourcesBlock: string): string {
  if (!sourcesBlock.includes("\n")) {
    // Ensure a break before every [n]
    sourcesBlock = sourcesBlock.replace(/\s*\[(\d+)\]\s*/g, "\n[$1] ");
    // And before every n. pattern if present
    sourcesBlock = sourcesBlock.replace(/\s+(\d+)\.\s/g, "\n$1. ");
    sourcesBlock = sourcesBlock.trim();
  }
  return sourcesBlock;
}

/**
 * Parses footnote definitions from sources block.
 */
function parseFootnoteDefinitions(sourcesBlock: string): string[] {
  return sourcesBlock
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\[\^\d+\]:/.test(l));
}

/**
 * Builds a citation renumbering map based on first-mention order in content.
 */
function buildCitationMap(mainContent: string, footnoteLines: string[]): Map<number, number> {
  const map = new Map<number, number>();
  const seen = new Set<number>();
  const firstMention: number[] = [];

  // Find first mention order in main content
  const refRe = /\[\^(\d+)\]/g;
  let mref: RegExpExecArray | null;
  while ((mref = refRe.exec(mainContent)) !== null) {
    const n = parseInt(mref[1], 10);
    if (!seen.has(n)) {
      seen.add(n);
      firstMention.push(n);
    }
  }

  if (firstMention.length > 0) {
    firstMention.forEach((n, i) => map.set(n, i + 1));
  } else {
    // Fallback to definition order
    let idx = 1;
    for (const line of footnoteLines) {
      const m = line.match(/^\[\^(\d+)\]:/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!map.has(n)) map.set(n, idx++);
      }
    }
  }

  return map;
}

/**
 * Normalizes citations in content using the provided mapping.
 */
export function normalizeCitations(content: string, map: Map<number, number>): string {
  // Already-footnote refs: [^n] -> [n] (remapped contiguously)
  // Use global flag with multiple passes to handle consecutive citations like [^7][^8]
  let result = content;
  let changed;
  do {
    changed = false;

    // Handle single citations: [^n] -> [n]
    result = result.replace(/\[\^(\d+)\]/g, (match, n: string) => {
      const oldN = parseInt(n, 10);
      const newN = map.get(oldN) ?? oldN;
      const replacement = `[${newN}]`;
      if (replacement !== match) {
        changed = true;
      }
      return replacement;
    });

    // Handle multiple citations: [^n, ^m] -> [n, m]
    result = result.replace(/\[\^(\d+(?:\s*,\s*\^?\d+)*)\]/g, (match, citationList: string) => {
      // Split and process each number in the list
      const processedNumbers = citationList
        .split(",")
        .map((part: string) => {
          const cleanPart = part.trim().replace(/^\^/, ""); // Remove leading ^
          const oldN = parseInt(cleanPart, 10);
          const newN = map.get(oldN) ?? oldN;
          return newN;
        })
        .sort((a: number, b: number) => a - b) // Sort numbers in ascending order
        .map((n: number) => n.toString())
        .join(", ");

      const replacement = `[${processedNumbers}]`;
      if (replacement !== match) {
        changed = true;
      }
      return replacement;
    });
  } while (changed);

  // Fix periods after citations that cause markdown list interpretation: [1]. -> [1]
  result = result.replace(/\[(\d+)\]\./g, "[$1]");

  return result;
}

/**
 * Converts footnote definitions to simple display items.
 */
function convertFootnoteDefinitions(sourcesBlock: string, map: Map<number, number>): string[] {
  const items: string[] = [];
  sourcesBlock.split("\n").forEach((line) => {
    const m = line.match(/^\[\^(\d+)\]:\s*(.*)$/);
    if (!m) return;
    const oldN = parseInt(m[1], 10);
    const newN = map.get(oldN) ?? oldN;
    const markdownLink = m[2].match(/\[([^\]]+)\]\(([^)]+)\)/);
    const wl = m[2].match(/\[\[(.*?)\]\]/);

    let display: string;
    if (markdownLink) {
      // Proper markdown link format: [Title](URL)
      display = `<a href="${markdownLink[2]}">${markdownLink[1]}</a>`;
    } else if (wl) {
      // Wiki link format: [[Title]]
      display = `[[${wl[1]}]]`;
    } else {
      // Handle malformed web citations like "Description text](URL)"
      const malformedLink = m[2].match(/^(.*?)\]\s*\(([^)]+)\)\s*$/);
      if (malformedLink) {
        // Extract text and URL from malformed pattern
        const text = malformedLink[1].trim();
        const url = malformedLink[2].trim();
        display = `<a href="${url}">${text}</a>`;
      } else {
        // Fallback: remove any trailing parenthetical content
        display = m[2].replace(/\s*\([^)]*\)\s*$/, "");
      }
    }
    items[newN - 1] = display;
  });
  return items;
}

/**
 * Consolidates duplicate sources and returns mapping for citation updates.
 */
function consolidateDuplicateSources(items: string[]): {
  uniqueItems: string[];
  consolidationMap: Map<number, number>;
} {
  const uniqueItems: string[] = [];
  const seenTitles = new Set<string>();
  const consolidationMap = new Map<number, number>(); // oldIndex -> newIndex

  items.forEach((item, originalIndex) => {
    if (!item) return;

    // Extract title from wikilink format [[title]] or use the item as-is
    const titleMatch = item.match(/\[\[(.*?)\]\]/);
    const title = titleMatch ? titleMatch[1].toLowerCase() : item.toLowerCase();

    if (!seenTitles.has(title)) {
      seenTitles.add(title);
      uniqueItems.push(item);
      consolidationMap.set(originalIndex + 1, uniqueItems.length); // 1-based indexing
    } else {
      // Find the index of the first occurrence
      const firstOccurrenceIndex = uniqueItems.findIndex((existing) => {
        const existingTitleMatch = existing.match(/\[\[(.*?)\]\]/);
        const existingTitle = existingTitleMatch
          ? existingTitleMatch[1].toLowerCase()
          : existing.toLowerCase();
        return existingTitle === title;
      });
      if (firstOccurrenceIndex >= 0) {
        consolidationMap.set(originalIndex + 1, firstOccurrenceIndex + 1); // 1-based indexing
      }
    }
  });

  return { uniqueItems, consolidationMap };
}

/**
 * Updates citations in content to reflect consolidated numbering.
 * Deduplicates within each bracket group after remapping.
 */
function updateCitationsForConsolidation(
  content: string,
  consolidationMap: Map<number, number>
): string {
  if (consolidationMap.size === 0) return content;

  return content.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_match, nums: string) => {
    const parts = nums.split(/\s*,\s*/);
    const seen = new Set<number>();
    const unique: number[] = [];
    for (const n of parts) {
      const remapped = consolidationMap.get(parseInt(n, 10)) || parseInt(n, 10);
      if (!seen.has(remapped)) {
        seen.add(remapped);
        unique.push(remapped);
      }
    }
    return `[${unique.join(", ")}]`;
  });
}

/**
 * Collapses duplicate citation brackets that appear next to each other.
 * Handles truly adjacent brackets ([1][1]) and brackets separated by
 * connectors like " and " or ", " ([1] and [1]).
 * Only collapses when the second bracket is a subset of the first.
 */
function deduplicateAdjacentCitations(content: string): string {
  let result = content;
  let prev;
  do {
    prev = result;
    // Match citation brackets separated by optional whitespace or connectors (" and ", ", ")
    result = result.replace(
      /\[(\d+(?:\s*,\s*\d+)*)\](?:\s*(?:and|,)\s*|\s*)\[(\d+(?:\s*,\s*\d+)*)\]/g,
      (match, first: string, second: string) => {
        const firstNums = new Set(first.split(/\s*,\s*/).map((s: string) => s.trim()));
        const secondNums = second.split(/\s*,\s*/).map((s: string) => s.trim());
        if (secondNums.every((n: string) => firstNums.has(n))) {
          return `[${[...firstNums].join(", ")}]`;
        }
        return match;
      }
    );
  } while (result !== prev);
  return result;
}

interface SourcesDisplayItem {
  index: number;
  html: string;
}

/**
 * Escapes HTML-sensitive characters to avoid unintended markup injection.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Type guard that filters out nullish values when mapping optional entries.
 */
function isNonNull<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * Converts a normalized sources block into display-ready list items.
 */
function parseSimpleSources(sourcesBlock: string): SourcesDisplayItem[] {
  const lines = sourcesBlock.split("\n");
  const items: SourcesDisplayItem[] = [];

  lines.forEach((rawLine) => {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      return;
    }

    const content = trimmed
      .replace(/^<li>/i, "")
      .replace(/<\/li>$/i, "")
      .replace(/^[-*]\s*/, "")
      .trim();

    if (!content) {
      return;
    }

    const markdownLink = content.match(/\[([^\]]+)\]\(([^)]+)\)/);
    const wikiLink = content.match(/\[\[(.*?)\]\]/);

    let html: string;
    if (markdownLink) {
      html = `<a href="${markdownLink[2]}">${markdownLink[1]}</a>`;
    } else if (wikiLink) {
      html = `[[${wikiLink[1]}]]`;
    } else {
      html = escapeHtml(content);
    }

    items.push({ index: items.length + 1, html });
  });

  return items;
}

/**
 * Appends a styled, collapsible sources list to the main message content.
 */
function buildSourcesDetails(mainContent: string, items: SourcesDisplayItem[]): string {
  const nonEmptyItems = items.filter((item) => item.html.trim().length > 0);
  if (nonEmptyItems.length === 0) {
    return mainContent;
  }

  const listItems = nonEmptyItems
    .map(
      ({ index, html }) =>
        `<li class="copilot-sources__item"><span class="copilot-sources__index">[${index}]</span><span class="copilot-sources__text">${html}</span></li>`
    )
    .join("\n");

  return (
    `${mainContent}\n\n<br/>\n` +
    `<details class="copilot-sources"><summary class="copilot-sources__summary">Sources</summary>\n` +
    `<ul class="copilot-sources__list">\n${listItems}\n</ul>\n</details>`
  );
}

/**
 * Wraps normalized citation references like [1] or [1, 2] in placeholder spans.
 * These spans provide visual feedback during streaming (styled as pending links)
 * and are replaced by linkInlineCitations with actual clickable anchors after streaming.
 */
function wrapCitationPlaceholders(content: string): string {
  return content.replace(
    /\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g,
    '<span class="copilot-citation-ref">[$1]</span>'
  );
}

/**
 * Main function to process inline citations in content.
 * Processes footnote-style citations and consolidates sources.
 */
export function processInlineCitations(
  content: string,
  enableInlineCitations: boolean = true
): string {
  // If inline citations are disabled, return content as-is
  if (!enableInlineCitations) {
    return content;
  }

  const sourcesSection = extractSourcesSection(content);
  if (!sourcesSection) return content;

  let { mainContent, sourcesBlock } = sourcesSection;
  sourcesBlock = normalizeSourcesBlock(sourcesBlock);

  // Process inline citations
  const footnoteLines = parseFootnoteDefinitions(sourcesBlock);
  if (footnoteLines.length === 0) {
    const simpleItems = parseSimpleSources(sourcesBlock);
    return buildSourcesDetails(mainContent, simpleItems);
  }

  // Process footnote-style citations
  const citationMap = buildCitationMap(mainContent, footnoteLines);
  mainContent = normalizeCitations(mainContent, citationMap);

  let items = convertFootnoteDefinitions(sourcesBlock, citationMap);
  const { uniqueItems, consolidationMap } = consolidateDuplicateSources(items);

  // Update citations to reflect consolidation and deduplicate
  if (consolidationMap.size > 0) {
    mainContent = updateCitationsForConsolidation(mainContent, consolidationMap);
    mainContent = deduplicateAdjacentCitations(mainContent);
    items = uniqueItems;
  }

  // Wrap citation numbers in placeholder spans for visual feedback during streaming
  mainContent = wrapCitationPlaceholders(mainContent);

  const detailedItems = items
    .map<SourcesDisplayItem | null>((item, index) => {
      if (!item) {
        return null;
      }
      return { index: index + 1, html: item };
    })
    .filter(isNonNull);

  return buildSourcesDetails(mainContent, detailedItems);
}
