import {
  createPdfJsWorkerEngine,
  PdfJsWorkerEngineError,
  type PdfJsApi,
  type PdfJsWorkerController,
  type PdfJsWorkerFactory,
  type PdfJsWorkerPort,
  type PdfJsWorkerRuntime,
} from "@/context/documents/pdfJsWorkerEngine";
import { parseLocalPdf } from "@/context/documents/localPdfParser";

interface FakePdfPage {
  getTextContent(): PromiseLike<{ readonly items: readonly { readonly str: string }[] }>;
}

interface FakePdfDocument {
  readonly numPages: number;
  getPage(pageNumber: number): PromiseLike<FakePdfPage>;
  cleanup?(): PromiseLike<void>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

class FakeWorkerPort implements PdfJsWorkerPort {
  readonly terminate = jest.fn();
  readonly postMessage = jest.fn();
  private readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  addEventListener(type: "error" | "message", listener: (event: { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: "error" | "message",
    listener: (event: { data?: unknown }) => void
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: "error" | "message", event: { data?: unknown } = {}): void {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

class FakeWorkerController implements PdfJsWorkerController {
  readonly destroy = jest.fn();
  readonly promise: PromiseLike<void>;
  port: PdfJsWorkerPort;

  constructor(
    options: { readonly port: PdfJsWorkerPort },
    ready: PromiseLike<void> = Promise.resolve()
  ) {
    this.port = options.port;
    this.promise = ready;
  }
}

interface HarnessOptions {
  readonly apiVersion?: string;
  readonly controllerReady?: PromiseLike<void>;
  readonly document?: FakePdfDocument;
  readonly emitWorkerVersion?: string;
  readonly mismatchControllerPort?: boolean;
  readonly suppressWorkerReady?: boolean;
  readonly workerFactory?: PdfJsWorkerFactory;
}

interface Harness {
  readonly api: PdfJsApi;
  readonly engine: ReturnType<typeof createPdfJsWorkerEngine>;
  readonly factory: PdfJsWorkerFactory;
  readonly getDocument: jest.Mock;
  readonly ports: FakeWorkerPort[];
  readonly controllers: FakeWorkerController[];
}

function runtime(): PdfJsWorkerRuntime {
  return {
    baseUrl: "https://vault.test/plugin/index.html",
    origin: "https://vault.test",
    setTimeout: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  };
}

function config(overrides: Partial<Parameters<typeof createPdfJsWorkerEngine>[3]> = {}) {
  return {
    allowedAssetPathPrefixes: ["/assets/", "/dist/"],
    expectedApiVersion: "6.3.289",
    expectedWorkerVersion: "6.3.289",
    standardFontDataPath: "/assets/standard_fonts/",
    workerAssetPath: "/dist/pdf.worker.mjs",
    ...overrides,
  };
}

function expectEngineCreationFailure(createEngine: () => unknown, code: string): void {
  try {
    createEngine();
    throw new Error("Expected PDF.js worker engine creation to fail");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function documentWithText(text: string): FakePdfDocument {
  return {
    numPages: 1,
    getPage: jest.fn(() =>
      Promise.resolve({
        getTextContent: () => Promise.resolve({ items: [{ str: text }] }),
      })
    ),
  };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const ports: FakeWorkerPort[] = [];
  const controllers: FakeWorkerController[] = [];
  const factory: PdfJsWorkerFactory = options.workerFactory ?? {
    createWorker: jest.fn(() => {
      const port = new FakeWorkerPort();
      ports.push(port);
      if (!options.suppressWorkerReady) {
        queueMicrotask(() =>
          port.emit("message", {
            data: {
              action: "ready",
              sourceName: "worker",
              ...(options.emitWorkerVersion === undefined
                ? {}
                : { version: options.emitWorkerVersion }),
            },
          })
        );
      }
      return port;
    }),
  };
  const PDFWorker = class extends FakeWorkerController {
    constructor(workerOptions: { readonly port: PdfJsWorkerPort }) {
      super(workerOptions, options.controllerReady ?? Promise.resolve());
      controllers.push(this);
      if (options.mismatchControllerPort) {
        this.port = new FakeWorkerPort();
      }
    }
  };
  const getDocument = jest.fn(() => ({
    destroy: jest.fn(),
    promise: Promise.resolve(options.document ?? documentWithText("local text")),
  }));
  const api = {
    PDFWorker,
    getDocument,
    version: options.apiVersion ?? "6.3.289",
  } as unknown as PdfJsApi;
  const engine = createPdfJsWorkerEngine(api, factory, runtime(), config());
  return { api, controllers, engine, factory, getDocument, ports };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

describe("pdfJsWorkerEngine", () => {
  describe("PdfJsWorkerEngineError", () => {
    describe("constructor()", () => {
      it("exposes only a bounded code and message", () => {
        const error = new PdfJsWorkerEngineError("engine-error");

        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(PdfJsWorkerEngineError);
        expect(error.code).toBe("engine-error");
        expect(error.message).toBe("PDF.js worker engine failed");
        expect(error.message).not.toContain("private");
      });
    });
  });

  describe("createPdfJsWorkerEngine()", () => {
    it("parses through a per-request worker and sends only local byte options", async () => {
      const harness = createHarness();

      const result = await parseLocalPdf(new Uint8Array([1, 2, 3]), harness.engine, {
        deadlineMs: 1_000,
      });

      expect(result.pages).toEqual([{ pageNumber: 1, text: "local text" }]);
      expect(harness.factory.createWorker).toHaveBeenCalledWith(
        new URL("https://vault.test/dist/pdf.worker.mjs")
      );
      expect(harness.api.getDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          disableAutoFetch: true,
          disableRange: true,
          disableStream: true,
          standardFontDataUrl: "https://vault.test/assets/standard_fonts/",
          useWorkerFetch: false,
        })
      );
      const documentOptions = harness.getDocument.mock.calls[0]?.[0] as {
        readonly data?: unknown;
        readonly url?: unknown;
      };
      expect(documentOptions.data).toBeInstanceOf(Uint8Array);
      expect(documentOptions).not.toHaveProperty("url");
      expect(harness.ports[0]?.terminate).toHaveBeenCalledTimes(1);
      expect(harness.controllers[0]?.destroy).toHaveBeenCalledTimes(1);
    });

    it("rejects remote or unallowlisted worker and font assets before creating a worker", () => {
      const harness = createHarness();

      expectEngineCreationFailure(
        () =>
          createPdfJsWorkerEngine(
            harness.api,
            harness.factory,
            runtime(),
            config({
              workerAssetPath: "https://remote.test/pdf.worker.mjs",
            })
          ),
        "invalid-configuration"
      );
      expectEngineCreationFailure(
        () =>
          createPdfJsWorkerEngine(
            harness.api,
            harness.factory,
            runtime(),
            config({
              standardFontDataPath: "/outside/fonts/",
            })
          ),
        "invalid-configuration"
      );
      expect(harness.factory.createWorker).not.toHaveBeenCalled();
    });

    it("fails closed for API and configured worker version mismatches", () => {
      const apiMismatch = createHarness();
      expectEngineCreationFailure(
        () =>
          createPdfJsWorkerEngine(
            { ...apiMismatch.api, version: "6.3.288" },
            apiMismatch.factory,
            runtime(),
            config()
          ),
        "api-version-mismatch"
      );

      const workerMismatch = createHarness();
      expectEngineCreationFailure(
        () =>
          createPdfJsWorkerEngine(
            workerMismatch.api,
            workerMismatch.factory,
            runtime(),
            config({ expectedWorkerVersion: "6.3.288" })
          ),
        "worker-version-mismatch"
      );
    });

    it("rejects a worker that reports a mismatched handshake version", async () => {
      const harness = createHarness({ emitWorkerVersion: "6.3.288" });
      const session = harness.engine.start(new Uint8Array([1]), {
        signal: new AbortController().signal,
      });

      await expect(session.document).rejects.toMatchObject({
        code: "worker-version-mismatch",
      });
      await session.destroy();
      await session.worker.terminate();
      expect(harness.ports[0]?.terminate).toHaveBeenCalledTimes(1);
    });

    it("does not accept a missing or replaced worker port", async () => {
      const missingWorker = createHarness({
        workerFactory: {
          createWorker: jest.fn(() => undefined as unknown as PdfJsWorkerPort),
        },
      });
      await expect(
        parseLocalPdf(new Uint8Array([1]), missingWorker.engine, { deadlineMs: 1_000 })
      ).rejects.toMatchObject({ code: "engine-error" });

      const replacedWorker = createHarness({ mismatchControllerPort: true });
      await expect(
        parseLocalPdf(new Uint8Array([1]), replacedWorker.engine, { deadlineMs: 1_000 })
      ).rejects.toMatchObject({ code: "engine-error" });
      expect(replacedWorker.ports[0]?.terminate).toHaveBeenCalledTimes(1);
      expect(replacedWorker.controllers[0]?.destroy).toHaveBeenCalledTimes(1);
    });

    it("uses independent worker and controller ownership for concurrent parses", async () => {
      const harness = createHarness();

      const [first, second] = await Promise.all([
        parseLocalPdf(new Uint8Array([1]), harness.engine, { deadlineMs: 1_000 }),
        parseLocalPdf(new Uint8Array([2]), harness.engine, { deadlineMs: 1_000 }),
      ]);

      expect(first.pages[0]?.text).toBe("local text");
      expect(second.pages[0]?.text).toBe("local text");
      expect(harness.ports).toHaveLength(2);
      expect(harness.ports[0]).not.toBe(harness.ports[1]);
      expect(harness.ports[0]?.terminate).toHaveBeenCalledTimes(1);
      expect(harness.ports[1]?.terminate).toHaveBeenCalledTimes(1);
      expect(harness.controllers).toHaveLength(2);
      expect(harness.controllers[0]?.destroy).toHaveBeenCalledTimes(1);
      expect(harness.controllers[1]?.destroy).toHaveBeenCalledTimes(1);
    });

    it("settles abort during worker startup and terminates the real request port", async () => {
      const harness = createHarness({ suppressWorkerReady: true });
      const controller = new AbortController();
      const parsing = parseLocalPdf(new Uint8Array([1]), harness.engine, {
        deadlineMs: 1_000,
        signal: controller.signal,
      });

      controller.abort();

      await expect(parsing).rejects.toMatchObject({ code: "aborted" });
      await flushAsyncWork();
      expect(harness.ports[0]?.terminate).toHaveBeenCalledTimes(1);
      expect(harness.controllers[0]?.destroy).toHaveBeenCalledTimes(1);
    });

    it("suppresses a late extraction result after abort", async () => {
      const textStarted = deferred<void>();
      const lateText = deferred<string>();
      const page = {
        getTextContent: jest.fn(() => {
          textStarted.resolve();
          return lateText.promise.then((text) => ({ items: [{ str: text }] }));
        }),
      };
      const document: FakePdfDocument = {
        numPages: 1,
        getPage: jest.fn(() => Promise.resolve(page)),
      };
      const harness = createHarness({ document });
      const controller = new AbortController();
      const parsing = parseLocalPdf(new Uint8Array([1]), harness.engine, {
        cleanupTimeoutMs: 20,
        deadlineMs: 1_000,
        signal: controller.signal,
      });

      await textStarted.promise;
      controller.abort();
      await expect(parsing).rejects.toMatchObject({ code: "aborted" });

      lateText.resolve("late private text");
      await flushAsyncWork();
      expect(harness.ports[0]?.terminate).toHaveBeenCalledTimes(1);
      expect(page.getTextContent).toHaveBeenCalledTimes(1);
    });

    it("sanitizes a PDF.js failure without exposing engine diagnostics", async () => {
      const harness = createHarness();
      harness.api.getDocument = jest.fn(() => {
        throw new Error("private worker diagnostic");
      });

      const parsing = parseLocalPdf(new Uint8Array([1]), harness.engine, {
        deadlineMs: 1_000,
      });

      await expect(parsing).rejects.toMatchObject({ code: "engine-error" });
      await expect(parsing).rejects.not.toThrow("private worker diagnostic");
    });
  });
});
