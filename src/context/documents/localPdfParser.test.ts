import { LocalPdfParseError, parseLocalPdf } from "@/context/documents/localPdfParser";
import type {
  LocalPdfParserEngine,
  PdfEngineDocument,
  PdfEnginePage,
  PdfEngineSession,
  PdfEngineWorker,
} from "@/context/documents/pdfTypes";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function worker(terminate: () => void | PromiseLike<void> = jest.fn()): PdfEngineWorker {
  return { kind: "worker", terminate };
}

function session(
  document: PromiseLike<PdfEngineDocument>,
  terminate: () => void | PromiseLike<void> = jest.fn(),
  destroy: () => void | PromiseLike<void> = jest.fn()
): PdfEngineSession {
  return {
    worker: worker(terminate),
    document,
    destroy,
  };
}

function documentWithPages(pages: readonly string[]): {
  document: PdfEngineDocument;
  getPage: jest.Mock<Promise<PdfEnginePage>, [number]>;
} {
  const getPage = jest.fn((pageNumber: number) => {
    const text = pages[pageNumber - 1] ?? "";
    return Promise.resolve({
      getTextContent: () => Promise.resolve(text),
    });
  });
  return {
    document: {
      pageCount: pages.length,
      getPage,
    },
    getPage,
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

describe("localPdfParser", () => {
  describe("LocalPdfParseError", () => {
    describe("constructor()", () => {
      it("exposes a bounded typed code without engine details", () => {
        const error = new LocalPdfParseError("engine-error");

        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(LocalPdfParseError);
        expect(error.code).toBe("engine-error");
        expect(error.message).toBe("Local PDF engine failed to parse the document");
      });
    });
  });

  describe("parseLocalPdf()", () => {
    it("returns explicit one-based pages and accepts pages without text", async () => {
      const parsed = documentWithPages(["first page", ""]);
      const terminate = jest.fn();
      const destroy = jest.fn();
      const engine: LocalPdfParserEngine = {
        start: jest.fn(() => session(Promise.resolve(parsed.document), terminate, destroy)),
      };

      const result = await parseLocalPdf(new Uint8Array([1, 2, 3]), engine);

      expect(result.pages).toEqual([
        { pageNumber: 1, text: "first page" },
        { pageNumber: 2, text: "" },
      ]);
      expect(result.metadata).toEqual({
        byteLength: 3,
        pageCount: 2,
        pagesProcessed: 2,
        outputCharacters: 10,
        pagesWithoutText: 1,
        noTextPageNumbers: [2],
      });
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledTimes(1);
    });

    it("reports no-text page numbers only up to the bounded list length", async () => {
      const parsed = documentWithPages(Array.from({ length: 30 }, () => ""));
      const engine: LocalPdfParserEngine = {
        start: jest.fn(() => session(Promise.resolve(parsed.document), jest.fn(), jest.fn())),
      };

      const result = await parseLocalPdf(new Uint8Array([1]), engine);

      expect(result.metadata.pagesWithoutText).toBe(30);
      expect(result.metadata.noTextPageNumbers).toHaveLength(20);
      expect(result.metadata.noTextPageNumbers[19]).toBe(20);
    });

    it("reports zero scanned pages when every page has a text layer", async () => {
      const parsed = documentWithPages(["alpha", "beta"]);
      const engine: LocalPdfParserEngine = {
        start: jest.fn(() => session(Promise.resolve(parsed.document), jest.fn(), jest.fn())),
      };

      const result = await parseLocalPdf(new Uint8Array([1]), engine);

      expect(result.metadata.pagesWithoutText).toBe(0);
      expect(result.metadata.noTextPageNumbers).toEqual([]);
    });

    it("rejects before engine start when the caller signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const start = jest.fn();
      const engine = { start } as unknown as LocalPdfParserEngine;

      await expect(
        parseLocalPdf(new Uint8Array([1]), engine, { signal: controller.signal })
      ).rejects.toMatchObject({ code: "aborted" });
      expect(start).not.toHaveBeenCalled();
    });

    it("settles cancellation during a stalled load and starts bounded cleanup", async () => {
      const controller = new AbortController();
      const loaded = deferred<PdfEngineDocument>();
      const destroy = jest.fn(() => new Promise<void>(() => undefined));
      const terminate = jest.fn(() => new Promise<void>(() => undefined));
      const engine: LocalPdfParserEngine = {
        start: jest.fn(() => session(loaded.promise, terminate, destroy)),
      };

      const parsing = parseLocalPdf(new Uint8Array([1]), engine, {
        signal: controller.signal,
        cleanupTimeoutMs: 5,
      });
      controller.abort();

      await expect(parsing).rejects.toMatchObject({ code: "aborted" });
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(terminate).toHaveBeenCalledTimes(1);
      loaded.resolve({
        pageCount: 0,
        getPage: jest.fn(),
        destroy: jest.fn(),
      });
      await flushAsyncWork();
    });

    it("settles a deadline during stalled page extraction without awaiting a hanging page destroy", async () => {
      const controller = new AbortController();
      const text = deferred<string>();
      const pageDestroy = jest.fn(() => new Promise<void>(() => undefined));
      const terminate = jest.fn();
      const destroy = jest.fn();
      const document: PdfEngineDocument = {
        pageCount: 1,
        getPage: jest.fn(() =>
          Promise.resolve({
            getTextContent: () => text.promise,
            destroy: pageDestroy,
          })
        ),
      };
      const engine: LocalPdfParserEngine = {
        start: jest.fn(() => session(Promise.resolve(document), terminate, destroy)),
      };

      const parsing = parseLocalPdf(new Uint8Array([1]), engine, {
        signal: controller.signal,
        cleanupTimeoutMs: 25,
      });
      await flushAsyncWork();
      controller.abort();

      await expect(parsing).rejects.toMatchObject({ code: "aborted" });
      expect(pageDestroy).toHaveBeenCalledTimes(1);
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(destroy).toHaveBeenCalledTimes(1);
      text.resolve("late text");
      await flushAsyncWork();
    });

    it("settles a deadline when both engine load and cleanup never resolve", async () => {
      const destroy = jest.fn(() => new Promise<void>(() => undefined));
      const terminate = jest.fn(() => new Promise<void>(() => undefined));
      const engine: LocalPdfParserEngine = {
        start: jest.fn(() =>
          session(new Promise<PdfEngineDocument>(() => undefined), terminate, destroy)
        ),
      };

      await expect(
        parseLocalPdf(new Uint8Array([1]), engine, {
          deadlineMs: 10,
          cleanupTimeoutMs: 5,
        })
      ).rejects.toMatchObject({ code: "deadline-exceeded" });
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(terminate).toHaveBeenCalledTimes(1);
    });

    it("does not return a result after the deadline expires during bounded cleanup", async () => {
      const destroy = jest.fn(() => new Promise<void>(() => undefined));
      const terminate = jest.fn(() => new Promise<void>(() => undefined));
      const parsed = documentWithPages(["text"]);
      const engine: LocalPdfParserEngine = {
        start: jest.fn(() => session(Promise.resolve(parsed.document), terminate, destroy)),
      };

      await expect(
        parseLocalPdf(new Uint8Array([1]), engine, {
          deadlineMs: 5,
          cleanupTimeoutMs: 25,
        })
      ).rejects.toMatchObject({ code: "deadline-exceeded" });
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(terminate).toHaveBeenCalledTimes(1);
    });

    it("keeps concurrent parses isolated with an independent worker per session", async () => {
      const starts: Array<{ bytes: Uint8Array; terminate: jest.Mock }> = [];
      const engine: LocalPdfParserEngine = {
        start: jest.fn((bytes) => {
          const marker = bytes[0] ?? 0;
          bytes[0] = 0;
          const terminate = jest.fn();
          starts.push({ bytes, terminate });
          return session(
            Promise.resolve({
              pageCount: 1,
              getPage: () =>
                Promise.resolve({
                  getTextContent: () => Promise.resolve(`marker-${marker}`),
                }),
            }),
            terminate
          );
        }),
      };
      const first = new Uint8Array([11]);
      const second = new Uint8Array([22]);

      const [firstResult, secondResult] = await Promise.all([
        parseLocalPdf(first, engine),
        parseLocalPdf(second, engine),
      ]);

      expect(first[0]).toBe(11);
      expect(second[0]).toBe(22);
      expect(firstResult.pages[0]?.text).toBe("marker-11");
      expect(secondResult.pages[0]?.text).toBe("marker-22");
      expect(starts).toHaveLength(2);
      expect(starts[0]?.bytes).not.toBe(starts[1]?.bytes);
      expect(starts[0]?.terminate).toHaveBeenCalledTimes(1);
      expect(starts[1]?.terminate).toHaveBeenCalledTimes(1);
    });

    it("rejects a document before extracting a page beyond the configured page limit", async () => {
      const parsed = documentWithPages(["one", "two", "three"]);
      const engine: LocalPdfParserEngine = {
        start: jest.fn(() => session(Promise.resolve(parsed.document))),
      };

      await expect(
        parseLocalPdf(new Uint8Array([1]), engine, { maxPages: 2 })
      ).rejects.toMatchObject({ code: "page-limit" });
      expect(parsed.getPage).not.toHaveBeenCalled();
    });

    it("rejects before returning partial text when the output limit is exceeded", async () => {
      const parsed = documentWithPages(["123"]);
      const engine: LocalPdfParserEngine = {
        start: jest.fn(() => session(Promise.resolve(parsed.document))),
      };

      await expect(
        parseLocalPdf(new Uint8Array([1]), engine, { maxOutputCharacters: 2 })
      ).rejects.toMatchObject({ code: "output-limit" });
      expect(parsed.getPage).toHaveBeenCalledWith(1);
    });

    it("rejects oversized bytes before copying or starting the engine", async () => {
      const start = jest.fn();
      const engine = { start } as unknown as LocalPdfParserEngine;

      await expect(
        parseLocalPdf(new Uint8Array([1, 2]), engine, { maxBytes: 1 })
      ).rejects.toMatchObject({ code: "byte-limit" });
      expect(start).not.toHaveBeenCalled();
    });

    it("rejects a missing or non-worker capability without a main-thread fallback", async () => {
      const destroy = jest.fn();
      const missingWorkerEngine = {
        start: jest.fn(() => ({
          worker: undefined,
          document: new Promise<PdfEngineDocument>(() => undefined),
          destroy,
        })),
      } as unknown as LocalPdfParserEngine;
      const mainThreadEngine = {
        start: jest.fn(() => ({
          worker: { kind: "main-thread", terminate: jest.fn() },
          document: new Promise<PdfEngineDocument>(() => undefined),
          destroy,
        })),
      } as unknown as LocalPdfParserEngine;

      await expect(parseLocalPdf(new Uint8Array([1]), missingWorkerEngine)).rejects.toMatchObject({
        code: "worker-unavailable",
      });
      await expect(parseLocalPdf(new Uint8Array([1]), mainThreadEngine)).rejects.toMatchObject({
        code: "worker-unavailable",
      });
      expect(destroy).toHaveBeenCalledTimes(2);
    });

    it.each(["malformed input", "encrypted input"])(
      "sanitizes the engine failure for %s",
      async (label) => {
        const engine: LocalPdfParserEngine = {
          start: jest.fn(() => session(Promise.reject(new Error(`private ${label} diagnostic`)))),
        };

        const promise = parseLocalPdf(new Uint8Array([1]), engine);

        await expect(promise).rejects.toMatchObject({ code: "engine-error" });
        await expect(promise).rejects.not.toThrow(label);
      }
    );
  });
});
