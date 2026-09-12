import { extractMarkdownImagePaths } from "@/LLMProviders/chainRunner/utils/imageExtraction";

const MAX_ASSET_REFERENCES = 128;
const MAX_ASSET_REFERENCE_LENGTH = 4096;

export type LocalAssetReferenceSyntax = "markdown" | "wiki";

/** One image destination extracted from Markdown or Obsidian wiki syntax. */
export interface LocalAssetReference {
  reference: string;
  syntax: LocalAssetReferenceSyntax;
}

/**
 * Extracts bounded image destinations without interpreting them as access
 * grants. The resolver applies local-only policy after this syntax step.
 *
 * @param markdown Note text containing Markdown or wiki image embeds.
 * @returns Image destinations in the two supported embed syntaxes.
 */
export function parseEmbeddedAssetReferences(markdown: string): LocalAssetReference[] {
  if (typeof markdown !== "string" || markdown.length === 0) {
    return [];
  }

  const references: LocalAssetReference[] = extractMarkdownImagePaths(markdown)
    .slice(0, MAX_ASSET_REFERENCES)
    .map((reference) => ({
      reference: reference.trim(),
      syntax: "markdown" as const,
    }))
    .filter((entry) => isBoundedReference(entry.reference));

  if (references.length >= MAX_ASSET_REFERENCES) {
    return references;
  }

  let searchIndex = 0;
  while (searchIndex < markdown.length && references.length < MAX_ASSET_REFERENCES) {
    const startIndex = markdown.indexOf("![[", searchIndex);
    if (startIndex === -1) {
      break;
    }

    const closeIndex = markdown.indexOf("]]", startIndex + 3);
    if (closeIndex === -1) {
      break;
    }

    const inner = markdown.slice(startIndex + 3, closeIndex);
    const reference = inner.split("|", 1)[0]?.trim() ?? "";
    if (isBoundedReference(reference)) {
      references.push({ reference, syntax: "wiki" });
    }
    searchIndex = closeIndex + 2;
  }

  return references;
}

function isBoundedReference(reference: string): boolean {
  return reference.length > 0 && reference.length <= MAX_ASSET_REFERENCE_LENGTH;
}
