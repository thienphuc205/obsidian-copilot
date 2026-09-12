export const DEFAULT_PDF_PARSE_LIMITS = Object.freeze({
  maxBytes: 25 * 1024 * 1024,
  maxPages: 200,
  maxOutputCharacters: 1_000_000,
  deadlineMs: 30_000,
  cleanupTimeoutMs: 50,
});

export type LocalPdfParseErrorCode =
  | "aborted"
  | "deadline-exceeded"
  | "invalid-bytes"
  | "invalid-limits"
  | "byte-limit"
  | "page-limit"
  | "output-limit"
  | "engine-unavailable"
  | "worker-unavailable"
  | "engine-error";

/** Options that bound a local PDF parse and connect it to caller cancellation. */
export interface LocalPdfParseOptions {
  readonly maxBytes?: number;
  readonly maxPages?: number;
  readonly maxOutputCharacters?: number;
  readonly deadlineMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Page-indexed text returned by an injected local PDF engine. */
export interface LocalPdfPageText {
  readonly pageNumber: number;
  readonly text: string;
}

/** Bounded metadata describing a local PDF parse without source paths or URLs. */
export interface LocalPdfParseMetadata {
  readonly byteLength: number;
  readonly pageCount: number;
  readonly pagesProcessed: number;
  readonly outputCharacters: number;
  /** Pages whose extracted text is empty after trimming; these are likely scanned. */
  readonly pagesWithoutText: number;
  /** First page numbers (one-based) with no text layer, bounded to avoid unbounded payloads. */
  readonly noTextPageNumbers: readonly number[];
}

/** Result of local PDF text extraction; an empty page text means no text was exposed. */
export interface LocalPdfParseResult {
  readonly pages: readonly LocalPdfPageText[];
  readonly metadata: LocalPdfParseMetadata;
}

/** Minimal byte-only parser contract shared by host adapters and file parsers. */
export interface LocalPdfParser {
  parse(bytes: Uint8Array, options?: LocalPdfParseOptions): Promise<LocalPdfParseResult>;
}

/** Worker capability owned by one parser session. */
export interface PdfEngineWorker {
  readonly kind: "worker";
  terminate(): void | PromiseLike<void>;
}

/** Text surface exposed by one page of an injected PDF engine. */
export interface PdfEnginePage {
  getTextContent(): PromiseLike<string>;
  destroy?(): void | PromiseLike<void>;
}

/** Page surface exposed by an injected PDF engine after document loading. */
export interface PdfEngineDocument {
  readonly pageCount: number;
  getPage(pageNumber: number): PromiseLike<PdfEnginePage>;
  destroy?(): void | PromiseLike<void>;
}

/** Per-request engine state returned synchronously after its worker is registered. */
export interface PdfEngineSession {
  readonly worker: PdfEngineWorker;
  readonly document: PromiseLike<PdfEngineDocument>;
  destroy(): void | PromiseLike<void>;
}

/** Dependency-injection boundary for a worker-backed, byte-only PDF engine. */
export interface LocalPdfParserEngine {
  start(bytes: Uint8Array, context: { readonly signal: AbortSignal }): PdfEngineSession;
}

/** Empty page storage shared by text-only documents with no extracted pages. */
export const EMPTY_LOCAL_PDF_PAGES: readonly LocalPdfPageText[] = Object.freeze([]);
