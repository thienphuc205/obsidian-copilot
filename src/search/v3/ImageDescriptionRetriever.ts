import { logWarn } from "@/logger";
import {
  ImageDescriptionStore,
  normalizeImageDescriptionEntry,
} from "@/context/assets/imageDescriptionStore";
import type { ImageDescriptionIO } from "@/context/assets/imageDescriptionStore";
import { createVaultImageDescriptionIO } from "@/context/assets/imageDescriptionStore";
import { Document } from "@langchain/core/documents";
import MiniSearch from "minisearch";
import type { App } from "obsidian";

/** Default result cap for image-description retrieval. */
const DEFAULT_MAX_K = 5;

/** Default BM25 score floor below which a hit is not returned. */
const DEFAULT_MIN_SCORE = 0.3;

/**
 * Options for ImageDescriptionRetriever.
 */
export interface ImageDescriptionRetrieverOptions {
  /** Maximum documents returned; defaults to {@link DEFAULT_MAX_K}. */
  maxK?: number;
  /** Minimum search score for a hit; defaults to {@link DEFAULT_MIN_SCORE}. */
  minScore?: number;
  /** IO override for tests; defaults to the vault-backed adapter. */
  io?: ImageDescriptionIO;
}

/**
 * One prepared store entry ready for MiniSearch indexing. `id` is the digest
 * so duplicate store entries collapse; `path` doubles as a search field.
 */
interface ImageIndexDoc {
  id: string;
  title: string;
  body: string;
  path: string;
}

/**
 * Validate untrusted store entries and index them in an ephemeral MiniSearch
 * (BM25) index, then return the query's top matches as LangChain Documents.
 * Entries without a vaultPath are skipped: without a file to open, their
 * citation could never be followed, so they add noise to the result list.
 *
 * @param entries Raw entries as loaded from the persisted store (untrusted).
 * @param query The user's search query.
 * @param options `maxK`/`minScore` overrides; defaults are 5 and 0.3.
 * @returns Matched Documents sorted by BM25 score descending.
 */
export function buildImageSearchDocuments(
  entries: readonly unknown[],
  query: string,
  options: Pick<ImageDescriptionRetrieverOptions, "maxK" | "minScore"> = {}
): Document[] {
  if (query.trim().length === 0) return [];

  const indexDocs = prepareIndexDocs(entries);
  if (indexDocs.length === 0) return [];

  const index = new MiniSearch<ImageIndexDoc>({ fields: ["title", "body", "path"] });
  for (const doc of indexDocs) {
    index.add(doc);
  }

  const maxK = options.maxK ?? DEFAULT_MAX_K;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const byId = new Map(indexDocs.map((doc) => [doc.id, doc]));
  const matched = index
    .search(query, { prefix: true, fuzzy: false, combineWith: "OR" })
    .filter((hit) => hit.score >= minScore)
    .slice(0, maxK);

  const documents = matched.flatMap((hit) => {
    const doc = byId.get(String(hit.id));
    if (!doc) return [];
    return [
      new Document({
        pageContent: doc.body,
        metadata: {
          title: `Image: ${doc.title}`,
          path: doc.path,
          source: "image_description",
          score: hit.score,
          rerank_score: hit.score,
          includeInContext: true,
          explanation: { type: "image", digest: doc.id, description: doc.body },
        },
      }),
    ];
  });
  return documents;
}

/**
 * Convert validated entries into MiniSearch index documents, collapsing
 * duplicate digests so the ephemeral index never sees a duplicate id.
 */
function prepareIndexDocs(entries: readonly unknown[]): ImageIndexDoc[] {
  const byDigest = new Map<string, ImageIndexDoc>();
  for (const value of entries) {
    const entry = normalizeImageDescriptionEntry(value);
    if (entry === null || entry.vaultPath === undefined) continue;
    const basename = entry.vaultPath.split("/").pop() ?? entry.vaultPath;
    byDigest.set(entry.digest, {
      id: entry.digest,
      title: basename,
      body: entry.description,
      path: entry.vaultPath,
    });
  }
  return Array.from(byDigest.values());
}

/**
 * Local-search retriever over the image description store: BM25 so a chat
 * query can surface an image by its description, with a citation whose `path`
 * opens the image. Loads fresh per query. Any failure yields empty results —
 * the image index can never break note search. Duck-typed like
 * FilterRetriever: SearchTools only calls `getRelevantDocuments(query)`.
 */
export class ImageDescriptionRetriever {
  constructor(
    private app: App,
    private options: ImageDescriptionRetrieverOptions = {}
  ) {}

  /**
   * Retrieve image-description documents matching the query.
   *
   * @param query - The user's search query.
   * @returns Matched Documents, or empty when the store is empty or unreadable.
   */
  public async getRelevantDocuments(query: string): Promise<Document[]> {
    try {
      const io = this.options.io ?? createVaultImageDescriptionIO(this.app.vault);
      const store = new ImageDescriptionStore(io);
      const entries = await store.list();
      return buildImageSearchDocuments(entries, query, this.options);
    } catch (error) {
      logWarn("Image description search failed:", error);
      return [];
    }
  }
}
