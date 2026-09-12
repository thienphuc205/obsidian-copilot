import {
  DEFAULT_PDF_PARSE_LIMITS,
  EMPTY_LOCAL_PDF_PAGES,
  type LocalPdfPageText,
  type LocalPdfParseErrorCode,
  type LocalPdfParseMetadata,
  type LocalPdfParseOptions,
  type LocalPdfParseResult,
  type LocalPdfParserEngine,
  type PdfEngineDocument,
  type PdfEnginePage,
  type PdfEngineSession,
  type PdfEngineWorker,
} from "@/context/documents/pdfTypes";

const ERROR_MESSAGES: Readonly<Record<LocalPdfParseErrorCode, string>> = {
  aborted: "Local PDF parsing was cancelled",
  "deadline-exceeded": "Local PDF parsing exceeded its deadline",
  "invalid-bytes": "Local PDF input bytes are invalid",
  "invalid-limits": "Local PDF parse limits are invalid",
  "byte-limit": "Local PDF input exceeds the byte limit",
  "page-limit": "Local PDF document exceeds the page limit",
  "output-limit": "Local PDF text exceeds the output limit",
  "engine-unavailable": "Local PDF parsing requires an injected engine",
  "worker-unavailable": "Local PDF parsing requires an isolated worker",
  "engine-error": "Local PDF engine failed to parse the document",
};

/** Upper bound for the number of no-text page numbers reported in metadata. */
const MAX_NO_TEXT_PAGE_NUMBERS = 20;

interface ResolvedLimits {
  readonly maxBytes: number;
  readonly maxPages: number;
  readonly maxOutputCharacters: number;
  readonly deadlineMs: number;
  readonly cleanupTimeoutMs: number;
}

interface CancellationState {
  readonly signal: AbortSignal;
  getFailure(): LocalPdfParseError | undefined;
  dispose(): void;
}

type TimerHandle = ReturnType<Window["setTimeout"]>;

/** Typed, bounded error returned by the local PDF parser. */
export class LocalPdfParseError extends Error {
  constructor(readonly code: LocalPdfParseErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "LocalPdfParseError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Extracts page-indexed text from bounded PDF bytes through an injected worker engine.
 *
 * The engine session must create its own worker synchronously. Engine promises may
 * remain pending after cancellation; the public parse promise still settles while
 * cleanup continues under its independent bound.
 *
 * @param bytes Exact PDF bytes already obtained from an approved local source.
 * @param engine Worker-backed PDF engine supplied by the caller.
 * @param options Byte, page, output, cancellation, and cleanup bounds.
 */
export async function parseLocalPdf(
  bytes: Uint8Array,
  engine: LocalPdfParserEngine,
  options: LocalPdfParseOptions = {}
): Promise<LocalPdfParseResult> {
  const limits = resolveLimits(options);
  validateBytes(bytes, limits);
  if (!engine || typeof engine.start !== "function") {
    throw new LocalPdfParseError("engine-unavailable");
  }

  const cancellation = createCancellation(options.signal, limits.deadlineMs);
  throwIfCancelled(cancellation);

  let session: PdfEngineSession | undefined;
  let worker: PdfEngineWorker | undefined;
  let activePage: PdfEnginePage | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let sessionDestroyPromise: Promise<void> | undefined;
  let workerTerminatePromise: Promise<void> | undefined;
  const destroyedResources = new WeakSet<object>();

  const destroyResource = (
    resource: PdfEnginePage | PdfEngineDocument | undefined
  ): Promise<void> => {
    if (!resource || typeof resource !== "object") {
      return Promise.resolve();
    }

    if (destroyedResources.has(resource)) {
      return Promise.resolve();
    }
    destroyedResources.add(resource);

    if (typeof resource.destroy !== "function") {
      return Promise.resolve();
    }
    return runBounded(() => resource.destroy?.(), limits.cleanupTimeoutMs);
  };

  const destroySession = (): Promise<void> => {
    if (sessionDestroyPromise) {
      return sessionDestroyPromise;
    }
    const currentSession = session;
    sessionDestroyPromise = currentSession
      ? runBounded(() => currentSession.destroy(), limits.cleanupTimeoutMs)
      : Promise.resolve();
    return sessionDestroyPromise;
  };

  const terminateWorker = (): Promise<void> => {
    if (workerTerminatePromise) {
      return workerTerminatePromise;
    }
    const currentWorker = worker;
    workerTerminatePromise = currentWorker
      ? runBounded(() => currentWorker.terminate(), limits.cleanupTimeoutMs)
      : Promise.resolve();
    return workerTerminatePromise;
  };

  const cleanup = (): Promise<void> => {
    if (cleanupPromise) {
      return cleanupPromise;
    }

    cleanupPromise = Promise.all([
      destroyResource(activePage),
      destroySession(),
      terminateWorker(),
    ]).then(() => undefined);
    return cleanupPromise;
  };

  try {
    const inputByteLength = bytes.byteLength;
    const source = new Uint8Array(bytes);
    throwIfCancelled(cancellation);
    session = engine.start(source, { signal: cancellation.signal });
    worker = getWorker(session);
    if (!worker) {
      throw new LocalPdfParseError("worker-unavailable");
    }
    if (typeof session.destroy !== "function") {
      throw new LocalPdfParseError("engine-error");
    }

    const document = await invokeEngine(
      () => session?.document ?? Promise.reject(new LocalPdfParseError("engine-error")),
      cancellation,
      (lateDocument) => destroyResource(lateDocument)
    );
    const pageCount = validatePageCount(document.pageCount);
    if (pageCount > limits.maxPages) {
      throw new LocalPdfParseError("page-limit");
    }

    const pages: LocalPdfPageText[] = [];
    let outputCharacters = 0;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      throwIfCancelled(cancellation);
      const page = await invokeEngine(
        () => document.getPage(pageNumber),
        cancellation,
        (latePage) => destroyResource(latePage)
      );
      activePage = page;
      try {
        if (!page || typeof page.getTextContent !== "function") {
          throw new LocalPdfParseError("engine-error");
        }
        const text = await invokeEngine(() => page.getTextContent(), cancellation);
        if (typeof text !== "string") {
          throw new LocalPdfParseError("engine-error");
        }
        if (outputCharacters + text.length > limits.maxOutputCharacters) {
          throw new LocalPdfParseError("output-limit");
        }
        outputCharacters += text.length;
        pages.push(Object.freeze({ pageNumber, text }));
      } finally {
        const pageCleanup = destroyResource(page);
        if (cancellation.getFailure()) {
          void pageCleanup;
        } else {
          await pageCleanup;
        }
        if (activePage === page) {
          activePage = undefined;
        }
      }
    }

    const noTextPageNumbers: number[] = [];
    for (const page of pages) {
      if (page.text.trim().length === 0 && noTextPageNumbers.length < MAX_NO_TEXT_PAGE_NUMBERS) {
        noTextPageNumbers.push(page.pageNumber);
      }
    }

    const metadata: LocalPdfParseMetadata = Object.freeze({
      byteLength: inputByteLength,
      pageCount,
      pagesProcessed: pages.length,
      outputCharacters,
      pagesWithoutText: pages.filter((page) => page.text.trim().length === 0).length,
      noTextPageNumbers: Object.freeze(noTextPageNumbers),
    });
    const result: LocalPdfParseResult = Object.freeze({
      pages: pages.length === 0 ? EMPTY_LOCAL_PDF_PAGES : Object.freeze(pages),
      metadata,
    });
    await cleanup();
    throwIfCancelled(cancellation);
    return result;
  } catch (error) {
    const failure = normalizeFailure(error, cancellation);
    void cleanup();
    throw failure;
  } finally {
    cancellation.dispose();
  }
}

function resolveLimits(options: LocalPdfParseOptions): ResolvedLimits {
  const maxBytes = resolveInteger(options.maxBytes, DEFAULT_PDF_PARSE_LIMITS.maxBytes, false);
  const maxPages = resolveInteger(options.maxPages, DEFAULT_PDF_PARSE_LIMITS.maxPages, false);
  const maxOutputCharacters = resolveInteger(
    options.maxOutputCharacters,
    DEFAULT_PDF_PARSE_LIMITS.maxOutputCharacters,
    true
  );
  const deadlineMs = resolveInteger(options.deadlineMs, DEFAULT_PDF_PARSE_LIMITS.deadlineMs, true);
  const cleanupTimeoutMs = resolveInteger(
    options.cleanupTimeoutMs,
    DEFAULT_PDF_PARSE_LIMITS.cleanupTimeoutMs,
    true
  );

  return { maxBytes, maxPages, maxOutputCharacters, deadlineMs, cleanupTimeoutMs };
}

function resolveInteger(value: number | undefined, fallback: number, allowZero: boolean): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new LocalPdfParseError("invalid-limits");
  }
  return value;
}

function validateBytes(bytes: Uint8Array, limits: ResolvedLimits): void {
  if (!(bytes instanceof Uint8Array)) {
    throw new LocalPdfParseError("invalid-bytes");
  }
  if (bytes.byteLength > limits.maxBytes) {
    throw new LocalPdfParseError("byte-limit");
  }
}

function validatePageCount(pageCount: number): number {
  if (!Number.isSafeInteger(pageCount) || pageCount < 0) {
    throw new LocalPdfParseError("engine-error");
  }
  return pageCount;
}

function getWorker(session: PdfEngineSession | undefined): PdfEngineWorker | undefined {
  if (!session || typeof session !== "object") {
    throw new LocalPdfParseError("engine-error");
  }
  const worker = session.worker;
  if (
    !worker ||
    typeof worker !== "object" ||
    worker.kind !== "worker" ||
    typeof worker.terminate !== "function"
  ) {
    return undefined;
  }
  return worker;
}

function createCancellation(
  externalSignal: AbortSignal | undefined,
  deadlineMs: number
): CancellationState {
  const controller = new AbortController();
  let failure: LocalPdfParseError | undefined;
  let timer: TimerHandle | undefined;
  let disposed = false;

  const abort = (nextFailure: LocalPdfParseError): void => {
    if (failure || disposed) {
      return;
    }
    failure = nextFailure;
    controller.abort();
  };
  const onExternalAbort = (): void => abort(new LocalPdfParseError("aborted"));

  if (externalSignal?.aborted) {
    onExternalAbort();
  } else {
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  }

  if (!failure && deadlineMs === 0) {
    abort(new LocalPdfParseError("deadline-exceeded"));
  } else if (!failure) {
    timer = window.setTimeout(() => abort(new LocalPdfParseError("deadline-exceeded")), deadlineMs);
  }

  return {
    signal: controller.signal,
    getFailure: () => failure,
    dispose: () => {
      disposed = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

function throwIfCancelled(cancellation: CancellationState): void {
  const failure = cancellation.getFailure();
  if (failure) {
    throw failure;
  }
}

function invokeEngine<T>(
  operation: () => PromiseLike<T>,
  cancellation: CancellationState,
  onLateResolve?: (value: T) => void | PromiseLike<void>
): Promise<T> {
  let result: PromiseLike<T>;
  try {
    result = operation();
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error("Local PDF engine operation failed")
    );
  }

  return settleWithCancellation(result, cancellation, onLateResolve);
}

function settleWithCancellation<T>(
  result: PromiseLike<T>,
  cancellation: CancellationState,
  onLateResolve?: (value: T) => void | PromiseLike<void>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let cancelled = false;
    const signal = cancellation.signal;
    const finish = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cancelled = true;
      finish();
      reject(cancellation.getFailure() ?? new LocalPdfParseError("aborted"));
    };

    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    Promise.resolve(result).then(
      (value) => {
        if (settled) {
          if (cancelled && onLateResolve) {
            try {
              void Promise.resolve(onLateResolve(value)).catch(() => undefined);
            } catch {
              return;
            }
          }
          return;
        }
        settled = true;
        finish();
        resolve(value);
      },
      (error: unknown) => {
        if (!settled) {
          settled = true;
          finish();
          reject(error instanceof Error ? error : new Error("Local PDF engine operation failed"));
        }
      }
    );
  });
}

async function runBounded(
  operation: () => void | PromiseLike<void>,
  timeoutMs: number
): Promise<void> {
  let result: PromiseLike<void>;
  try {
    result = Promise.resolve(operation());
  } catch {
    return;
  }

  await new Promise<void>((resolve) => {
    let timer: TimerHandle | undefined;
    let finished = false;
    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      resolve();
    };
    timer = window.setTimeout(finish, timeoutMs);
    result.then(finish, finish);
  });
}

function normalizeFailure(error: unknown, cancellation: CancellationState): LocalPdfParseError {
  if (error instanceof LocalPdfParseError) {
    return error;
  }
  return cancellation.getFailure() ?? new LocalPdfParseError("engine-error");
}
