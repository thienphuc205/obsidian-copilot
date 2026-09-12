import type {
  LocalPdfParserEngine,
  PdfEngineDocument,
  PdfEnginePage,
  PdfEngineSession,
  PdfEngineWorker,
} from "@/context/documents/pdfTypes";

const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 250;

const ERROR_MESSAGES = {
  aborted: "PDF.js worker parsing was cancelled",
  "api-version-mismatch": "PDF.js API version is not approved",
  "engine-error": "PDF.js worker engine failed",
  "invalid-configuration": "PDF.js worker configuration is invalid",
  "worker-handshake-timeout": "PDF.js worker did not become ready",
  "worker-startup": "PDF.js worker failed during startup",
  "worker-unavailable": "PDF.js worker is unavailable",
  "worker-version-mismatch": "PDF.js worker version is not approved",
} as const;

export type PdfJsWorkerEngineErrorCode = keyof typeof ERROR_MESSAGES;

/** Minimal message surface needed from a browser or host-owned worker. */
export interface PdfJsWorkerEvent {
  readonly data?: unknown;
  readonly message?: string;
}

export type PdfJsWorkerListener = (event: PdfJsWorkerEvent) => void;

/** A worker port owned by one PDF.js parser request. */
export interface PdfJsWorkerPort {
  addEventListener(type: "error" | "message", listener: PdfJsWorkerListener): void;
  removeEventListener(type: "error" | "message", listener: PdfJsWorkerListener): void;
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  terminate(): void | PromiseLike<void>;
}

/** Explicit factory used to create the local worker for each parser request. */
export interface PdfJsWorkerFactory {
  createWorker(assetUrl: URL): PdfJsWorkerPort;
}

/** Timer and origin primitives supplied by the host that owns the PDF assets. */
export interface PdfJsWorkerRuntime {
  readonly baseUrl: string;
  readonly origin: string;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** PDF.js worker controller created with the request's explicit worker port. */
export interface PdfJsWorkerController {
  readonly port: PdfJsWorkerPort;
  readonly promise: PromiseLike<void>;
  destroy(): void | PromiseLike<void>;
}

interface PdfJsTextItem {
  readonly str?: unknown;
}

interface PdfJsTextContent {
  readonly items: readonly PdfJsTextItem[];
}

interface PdfJsPageProxy {
  getTextContent(): PromiseLike<PdfJsTextContent>;
  cleanup?(): boolean | void;
}

interface PdfJsDocumentProxy {
  readonly numPages: number;
  getPage(pageNumber: number): PromiseLike<PdfJsPageProxy>;
  cleanup?(): PromiseLike<unknown> | void;
}

interface PdfJsLoadingTask {
  readonly promise: PromiseLike<PdfJsDocumentProxy>;
  destroy(): void | PromiseLike<void>;
}

interface PdfJsDocumentOptions {
  readonly data: Uint8Array;
  readonly disableAutoFetch: true;
  readonly disableRange: true;
  readonly disableStream: true;
  readonly enableScripting: false;
  readonly isEvalSupported: false;
  readonly isImageDecoderSupported: false;
  readonly isOffscreenCanvasSupported: false;
  readonly maxImageSize: number;
  readonly standardFontDataUrl: string;
  readonly stopAtErrors: true;
  readonly useSystemFonts: false;
  readonly useWasm: false;
  readonly useWorkerFetch: false;
  readonly worker: PdfJsWorkerController;
}

/** Injected PDF.js API surface; the adapter never imports or configures PDF.js globally. */
export interface PdfJsApi {
  readonly version: string;
  readonly PDFWorker: new (options: { readonly port: PdfJsWorkerPort }) => PdfJsWorkerController;
  getDocument(options: PdfJsDocumentOptions): PdfJsLoadingTask;
}

/** Local, version-pinned asset and lifecycle policy for one PDF.js adapter. */
export interface PdfJsWorkerConfig {
  readonly allowedAssetPathPrefixes: readonly string[];
  readonly expectedApiVersion: string;
  readonly expectedWorkerVersion: string;
  readonly standardFontDataPath: string;
  readonly workerAssetPath: string;
  readonly cleanupTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
}

interface ResolvedConfiguration {
  readonly cleanupTimeoutMs: number;
  readonly fontUrl: URL;
  readonly startupTimeoutMs: number;
  readonly workerUrl: URL;
}

/** Bounded error that deliberately excludes PDF.js diagnostics and source details. */
export class PdfJsWorkerEngineError extends Error {
  constructor(readonly code: PdfJsWorkerEngineErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "PdfJsWorkerEngineError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Creates a byte-only LocalPdfParserEngine backed by one explicit local PDF.js worker per request.
 *
 * The returned engine owns no global PDF.js settings and accepts no document URL. Asset URLs are
 * derived from the injected host origin and checked against the configured local path prefixes.
 *
 * @param api Version-pinned PDF.js API supplied by the host.
 * @param workerFactory Factory that creates a real worker for one request.
 * @param runtime Host origin and bounded timer primitives.
 * @param config Local worker/font paths and version/lifecycle policy.
 */
export function createPdfJsWorkerEngine(
  api: PdfJsApi,
  workerFactory: PdfJsWorkerFactory,
  runtime: PdfJsWorkerRuntime,
  config: PdfJsWorkerConfig
): LocalPdfParserEngine {
  const resolved = resolveConfiguration(api, workerFactory, runtime, config);

  return {
    start(bytes, context): PdfEngineSession {
      if (context.signal.aborted) {
        throw new PdfJsWorkerEngineError("aborted");
      }

      let port: PdfJsWorkerPort;
      try {
        port = workerFactory.createWorker(resolved.workerUrl);
      } catch {
        throw new PdfJsWorkerEngineError("worker-unavailable");
      }
      if (!isWorkerPort(port)) {
        throw new PdfJsWorkerEngineError("worker-unavailable");
      }

      let pdfWorker: PdfJsWorkerController | undefined;
      try {
        pdfWorker = new api.PDFWorker({ port });
        if (!pdfWorker || pdfWorker.port !== port || !isPromiseLike(pdfWorker.promise)) {
          throw new PdfJsWorkerEngineError("worker-unavailable");
        }
      } catch (error) {
        void runBounded(() => pdfWorker?.destroy(), runtime, resolved.cleanupTimeoutMs);
        void terminatePort(port, runtime, resolved.cleanupTimeoutMs);
        if (error instanceof PdfJsWorkerEngineError) {
          throw error;
        }
        throw new PdfJsWorkerEngineError("worker-startup");
      }
      if (!pdfWorker) {
        throw new PdfJsWorkerEngineError("worker-unavailable");
      }
      const activePdfWorker = pdfWorker;

      let task: PdfJsLoadingTask | undefined;
      let destroyPromise: Promise<void> | undefined;
      let terminationPromise: Promise<void> | undefined;

      const destroy = (): Promise<void> => {
        if (destroyPromise) {
          return destroyPromise;
        }
        destroyPromise = Promise.all([
          runBounded(() => task?.destroy(), runtime, resolved.cleanupTimeoutMs),
          runBounded(() => activePdfWorker.destroy(), runtime, resolved.cleanupTimeoutMs),
        ]).then(() => undefined);
        return destroyPromise;
      };

      const worker: PdfEngineWorker = {
        kind: "worker",
        terminate: (): Promise<void> => {
          if (terminationPromise) {
            return terminationPromise;
          }
          terminationPromise = terminatePort(port, runtime, resolved.cleanupTimeoutMs);
          return terminationPromise;
        },
      };

      const onAbort = (): void => {
        void Promise.all([destroy(), worker.terminate()]);
      };
      context.signal.addEventListener("abort", onAbort, { once: true });

      const document = (async (): Promise<PdfEngineDocument> => {
        try {
          await waitForWorkerReady(
            port,
            resolved.startupTimeoutMs,
            config.expectedWorkerVersion,
            runtime,
            context.signal
          );
          await settleWithAbort(activePdfWorker.promise, context.signal);
          if (context.signal.aborted) {
            throw new PdfJsWorkerEngineError("aborted");
          }

          task = api.getDocument({
            data: new Uint8Array(bytes),
            disableAutoFetch: true,
            disableRange: true,
            disableStream: true,
            enableScripting: false,
            isEvalSupported: false,
            isImageDecoderSupported: false,
            isOffscreenCanvasSupported: false,
            maxImageSize: 1_000_000,
            standardFontDataUrl: resolved.fontUrl.href,
            stopAtErrors: true,
            useSystemFonts: false,
            useWasm: false,
            useWorkerFetch: false,
            worker: activePdfWorker,
          });
          const pdfDocument = await settleWithAbort(task.promise, context.signal);
          return adaptDocument(pdfDocument);
        } catch (error) {
          throw normalizeFailure(error);
        } finally {
          context.signal.removeEventListener("abort", onAbort);
        }
      })();

      return { destroy, document, worker };
    },
  };
}

function resolveConfiguration(
  api: PdfJsApi,
  workerFactory: PdfJsWorkerFactory,
  runtime: PdfJsWorkerRuntime,
  config: PdfJsWorkerConfig
): ResolvedConfiguration {
  if (
    !api ||
    typeof api.version !== "string" ||
    typeof api.PDFWorker !== "function" ||
    typeof api.getDocument !== "function"
  ) {
    throw new PdfJsWorkerEngineError("api-version-mismatch");
  }
  if (typeof config?.expectedApiVersion !== "string" || api.version !== config.expectedApiVersion) {
    throw new PdfJsWorkerEngineError("api-version-mismatch");
  }
  if (
    typeof config.expectedWorkerVersion !== "string" ||
    config.expectedWorkerVersion !== config.expectedApiVersion
  ) {
    throw new PdfJsWorkerEngineError("worker-version-mismatch");
  }
  if (!workerFactory || typeof workerFactory.createWorker !== "function") {
    throw new PdfJsWorkerEngineError("worker-unavailable");
  }
  if (
    !runtime ||
    typeof runtime.baseUrl !== "string" ||
    typeof runtime.origin !== "string" ||
    typeof runtime.setTimeout !== "function" ||
    typeof runtime.clearTimeout !== "function"
  ) {
    throw new PdfJsWorkerEngineError("invalid-configuration");
  }

  const startupTimeoutMs = resolveTimeout(config.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS);
  const cleanupTimeoutMs = resolveTimeout(config.cleanupTimeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS);
  if (
    !Array.isArray(config.allowedAssetPathPrefixes) ||
    config.allowedAssetPathPrefixes.length === 0
  ) {
    throw new PdfJsWorkerEngineError("invalid-configuration");
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(runtime.baseUrl);
  } catch {
    throw new PdfJsWorkerEngineError("invalid-configuration");
  }
  if (baseUrl.origin !== runtime.origin) {
    throw new PdfJsWorkerEngineError("invalid-configuration");
  }

  return {
    cleanupTimeoutMs,
    fontUrl: resolveLocalAsset(config.standardFontDataPath, baseUrl, runtime, config),
    startupTimeoutMs,
    workerUrl: resolveLocalAsset(config.workerAssetPath, baseUrl, runtime, config),
  };
}

function resolveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) {
    throw new PdfJsWorkerEngineError("invalid-configuration");
  }
  return value;
}

function resolveLocalAsset(
  assetPath: string,
  baseUrl: URL,
  runtime: PdfJsWorkerRuntime,
  config: PdfJsWorkerConfig
): URL {
  if (typeof assetPath !== "string" || assetPath.length === 0) {
    throw new PdfJsWorkerEngineError("invalid-configuration");
  }

  let assetUrl: URL;
  try {
    assetUrl = new URL(assetPath, baseUrl);
  } catch {
    throw new PdfJsWorkerEngineError("invalid-configuration");
  }

  const pathAllowed = config.allowedAssetPathPrefixes.some((prefix) => {
    if (typeof prefix !== "string" || prefix.length === 0) {
      return false;
    }
    const normalizedPrefix = prefix.startsWith("/")
      ? prefix.endsWith("/")
        ? prefix
        : `${prefix}/`
      : `/${prefix.endsWith("/") ? prefix : `${prefix}/`}`;
    return assetUrl.pathname.startsWith(normalizedPrefix);
  });
  if (
    assetUrl.origin !== baseUrl.origin ||
    assetUrl.origin !== runtime.origin ||
    assetUrl.protocol !== baseUrl.protocol ||
    assetUrl.username !== "" ||
    assetUrl.password !== "" ||
    assetUrl.search !== "" ||
    assetUrl.hash !== "" ||
    !pathAllowed
  ) {
    throw new PdfJsWorkerEngineError("invalid-configuration");
  }
  return assetUrl;
}

function isWorkerPort(value: unknown): value is PdfJsWorkerPort {
  if (!value || typeof value !== "object") {
    return false;
  }
  const port = value as PdfJsWorkerPort;
  return (
    typeof port.addEventListener === "function" &&
    typeof port.removeEventListener === "function" &&
    typeof port.postMessage === "function" &&
    typeof port.terminate === "function"
  );
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return Boolean(value && typeof (value as PromiseLike<T>).then === "function");
}

function adaptDocument(pdfDocument: PdfJsDocumentProxy): PdfEngineDocument {
  if (
    !pdfDocument ||
    !Number.isSafeInteger(pdfDocument.numPages) ||
    pdfDocument.numPages < 0 ||
    typeof pdfDocument.getPage !== "function"
  ) {
    throw new PdfJsWorkerEngineError("engine-error");
  }

  return {
    pageCount: pdfDocument.numPages,
    getPage: (pageNumber) =>
      Promise.resolve(pdfDocument.getPage(pageNumber)).then((pdfPage) => adaptPage(pdfPage)),
    destroy: () => Promise.resolve(pdfDocument.cleanup?.()).then(() => undefined),
  };
}

function adaptPage(pdfPage: PdfJsPageProxy): PdfEnginePage {
  if (!pdfPage || typeof pdfPage.getTextContent !== "function") {
    throw new PdfJsWorkerEngineError("engine-error");
  }
  return {
    getTextContent: () =>
      Promise.resolve(pdfPage.getTextContent()).then((content) => {
        if (!isPdfJsTextContent(content)) {
          throw new PdfJsWorkerEngineError("engine-error");
        }
        return content.items.map((item) => (typeof item.str === "string" ? item.str : "")).join("");
      }),
    destroy: () => {
      pdfPage.cleanup?.();
    },
  };
}

function waitForWorkerReady(
  port: PdfJsWorkerPort,
  timeoutMs: number,
  expectedWorkerVersion: string,
  runtime: PdfJsWorkerRuntime,
  signal: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: unknown;

    const cleanup = (): void => {
      port.removeEventListener("message", onMessage);
      port.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      if (timer !== undefined) {
        runtime.clearTimeout(timer);
      }
    };
    const finish = (failure?: PdfJsWorkerEngineError): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (failure) {
        reject(failure);
      } else {
        resolve();
      }
    };
    const onMessage: PdfJsWorkerListener = (event) => {
      const data = asRecord(event.data);
      if (data?.action !== "ready" || data.sourceName !== "worker") {
        return;
      }
      if (typeof data.version === "string" && data.version !== expectedWorkerVersion) {
        finish(new PdfJsWorkerEngineError("worker-version-mismatch"));
        return;
      }
      finish();
    };
    const onError: PdfJsWorkerListener = () => {
      finish(new PdfJsWorkerEngineError("worker-startup"));
    };
    const onAbort = (): void => {
      finish(new PdfJsWorkerEngineError("aborted"));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      timer = runtime.setTimeout(
        () => finish(new PdfJsWorkerEngineError("worker-handshake-timeout")),
        timeoutMs
      );
      port.addEventListener("message", onMessage);
      if (settled) {
        return;
      }
      port.addEventListener("error", onError);
      if (settled) {
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    } catch {
      finish(new PdfJsWorkerEngineError("worker-startup"));
    }
  });
}

function settleWithAbort<T>(value: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      finish();
      reject(new PdfJsWorkerEngineError("aborted"));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        if (settled) {
          return;
        }
        settled = true;
        finish();
        resolve(result);
      },
      () => {
        if (settled) {
          return;
        }
        settled = true;
        finish();
        reject(new PdfJsWorkerEngineError("engine-error"));
      }
    );
  });
}

function normalizeFailure(error: unknown): PdfJsWorkerEngineError {
  if (error instanceof PdfJsWorkerEngineError) {
    return error;
  }
  return new PdfJsWorkerEngineError("engine-error");
}

async function terminatePort(
  port: PdfJsWorkerPort,
  runtime: PdfJsWorkerRuntime,
  timeoutMs: number
): Promise<void> {
  await runBounded(() => port.terminate(), runtime, timeoutMs);
}

async function runBounded(
  operation: () => void | PromiseLike<unknown>,
  runtime: PdfJsWorkerRuntime,
  timeoutMs: number
): Promise<void> {
  let result: PromiseLike<unknown>;
  try {
    result = Promise.resolve(operation());
  } catch {
    return;
  }

  await new Promise<void>((resolve) => {
    let finished = false;
    let timer: unknown;
    const finish = (): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (timer !== undefined) {
        runtime.clearTimeout(timer);
      }
      resolve();
    };
    timer = runtime.setTimeout(finish, timeoutMs);
    result.then(finish, finish);
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function isPdfJsTextContent(value: unknown): value is PdfJsTextContent {
  const record = asRecord(value);
  return Boolean(
    record &&
    Array.isArray(record.items) &&
    record.items.every((item) => item && typeof item === "object")
  );
}
