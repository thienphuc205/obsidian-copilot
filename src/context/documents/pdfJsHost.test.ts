jest.mock("pdfjs-dist", () => ({
  PDFWorker: jest.fn(),
  getDocument: jest.fn(),
  version: "6.3.289",
}));

import * as pdfjs from "pdfjs-dist";

import {
  createPdfJsLocalParser,
  PDF_JS_ASSET_PATHS,
  PDF_JS_VERSION,
  type PdfJsHost,
} from "@/context/documents/pdfJsHost";
import type { PdfJsWorkerController, PdfJsWorkerPort } from "@/context/documents/pdfJsWorkerEngine";

class FakeWorkerPort implements PdfJsWorkerPort {
  readonly postMessage = jest.fn();
  readonly terminate = jest.fn();
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
  readonly promise = Promise.resolve();
  readonly port: PdfJsWorkerPort;

  constructor(options: { readonly port: PdfJsWorkerPort }) {
    this.port = options.port;
  }
}

const getDocumentMock = pdfjs.getDocument as unknown as jest.Mock;
const pdfWorkerMock = pdfjs.PDFWorker as unknown as jest.Mock;

function createHost(
  resourcePath: (normalizedPath: string) => string = (normalizedPath) =>
    `app://obsidian.md/plugins/copilot/${normalizedPath}`,
  trustedLocalOrigin = "app://obsidian.md"
): {
  host: PdfJsHost;
  getResourcePath: jest.Mock;
  createWorker: jest.Mock;
  ports: FakeWorkerPort[];
} {
  const ports: FakeWorkerPort[] = [];
  const getResourcePath = jest.fn(resourcePath);
  const createWorker = jest.fn((assetUrl: URL) => {
    const port = new FakeWorkerPort();
    ports.push(port);
    queueMicrotask(() => port.emit("message", { data: { action: "ready", sourceName: "worker" } }));
    expect(assetUrl.protocol).toBe(new URL(trustedLocalOrigin).protocol);
    return port;
  });
  return {
    createWorker,
    getResourcePath,
    host: {
      trustedLocalOrigin,
      resources: { getResourcePath },
      runtime: {
        clearTimeout: (handle) => window.clearTimeout(handle as number),
        createWorker,
        setTimeout: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
      },
    },
    ports,
  };
}

function installDocumentFixture(): void {
  getDocumentMock.mockReturnValue({
    destroy: jest.fn(),
    promise: Promise.resolve({
      cleanup: jest.fn(),
      getPage: jest.fn(() =>
        Promise.resolve({
          cleanup: jest.fn(),
          getTextContent: jest.fn(() => Promise.resolve({ items: [{ str: "host text" }] })),
        })
      ),
      numPages: 1,
    }),
  });
}

describe("pdfJsHost", () => {
  describe("createPdfJsLocalParser()", () => {
    beforeEach(() => {
      jest.clearAllMocks();
      pdfWorkerMock.mockImplementation(
        (options: { readonly port: PdfJsWorkerPort }) => new FakeWorkerController(options)
      );
      installDocumentFixture();
    });

    it("composes the exact packaged paths with a byte-only parser", async () => {
      const harness = createHost();
      const parser = createPdfJsLocalParser(harness.host);

      const result = await parser.parse(new Uint8Array([1, 2, 3]), { deadlineMs: 1_000 });

      expect(PDF_JS_VERSION).toBe("6.3.289");
      expect(result.pages).toEqual([{ pageNumber: 1, text: "host text" }]);
      expect(harness.getResourcePath).toHaveBeenNthCalledWith(1, PDF_JS_ASSET_PATHS.api);
      expect(harness.getResourcePath).toHaveBeenNthCalledWith(2, PDF_JS_ASSET_PATHS.worker);
      expect(harness.getResourcePath).toHaveBeenNthCalledWith(3, PDF_JS_ASSET_PATHS.standardFonts);
      expect(harness.createWorker).toHaveBeenCalledWith(
        new URL("app://obsidian.md/plugins/copilot/pdfjs/pdf.worker.mjs")
      );
      expect(getDocumentMock).toHaveBeenCalledWith(
        expect.objectContaining({
          standardFontDataUrl: "app://obsidian.md/plugins/copilot/pdfjs/standard_fonts/",
          useWorkerFetch: false,
        })
      );
      expect(getDocumentMock.mock.calls[0]?.[0]).not.toHaveProperty("url");
      expect(harness.ports[0]?.terminate).toHaveBeenCalledTimes(1);
    });

    it("preserves receiver context for injected runtime methods", async () => {
      const harness = createHost();
      type ReceiverRuntime = PdfJsHost["runtime"] & {
        clearTimeoutCalls: number;
        createWorkerCalls: number;
        setTimeoutCalls: number;
      };
      const runtime: ReceiverRuntime = {
        clearTimeoutCalls: 0,
        createWorker(assetUrl) {
          this.createWorkerCalls += 1;
          harness.createWorker(assetUrl);
          const port = harness.ports[harness.ports.length - 1];
          if (!port) {
            throw new Error("The worker harness did not create a port");
          }
          return port;
        },
        createWorkerCalls: 0,
        setTimeout(callback, milliseconds) {
          this.setTimeoutCalls += 1;
          return window.setTimeout(callback, milliseconds);
        },
        setTimeoutCalls: 0,
        clearTimeout(handle) {
          this.clearTimeoutCalls += 1;
          window.clearTimeout(handle as number);
        },
      };
      const parser = createPdfJsLocalParser({ ...harness.host, runtime });

      await parser.parse(new Uint8Array([1, 2, 3]), { deadlineMs: 1_000 });

      expect(runtime.createWorkerCalls).toBe(1);
      expect(runtime.setTimeoutCalls).toBeGreaterThan(0);
      expect(runtime.clearTimeoutCalls).toBe(runtime.setTimeoutCalls);
    });

    it("rejects unsupported or cross-authority resource URLs before creating a worker", () => {
      const fileHarness = createHost((normalizedPath) => `file:///tmp/${normalizedPath}`);
      expect(() => createPdfJsLocalParser(fileHarness.host)).toThrow(
        "PDF.js worker configuration is invalid"
      );
      expect(fileHarness.createWorker).not.toHaveBeenCalled();

      const crossAuthorityHarness = createHost((normalizedPath) =>
        normalizedPath === PDF_JS_ASSET_PATHS.worker
          ? `app://other.example/plugins/copilot/${normalizedPath}`
          : `app://obsidian.md/plugins/copilot/${normalizedPath}`
      );
      expect(() => createPdfJsLocalParser(crossAuthorityHarness.host)).toThrow(
        "PDF.js worker configuration is invalid"
      );
      expect(crossAuthorityHarness.createWorker).not.toHaveBeenCalled();
    });

    it("accepts only the exact app origin or an explicitly trusted loopback origin", async () => {
      const loopbackHarness = createHost(
        (normalizedPath) => `http://127.0.0.1:53310/plugins/copilot/${normalizedPath}`,
        "http://127.0.0.1:53310"
      );
      const parser = createPdfJsLocalParser(loopbackHarness.host);

      await parser.parse(new Uint8Array([1, 2, 3]), { deadlineMs: 1_000 });

      expect(loopbackHarness.createWorker).toHaveBeenCalledWith(
        new URL("http://127.0.0.1:53310/plugins/copilot/pdfjs/pdf.worker.mjs")
      );
    });

    it("rejects remote, mismatched, scheme-relative, credentialed, escaped, and sibling asset paths before PDF.js use", () => {
      const cases: Array<{
        name: string;
        resourcePath: (normalizedPath: string) => string;
        trustedLocalOrigin?: string;
      }> = [
        {
          name: "remote HTTP",
          resourcePath: (normalizedPath) => `http://remote.example/${normalizedPath}`,
        },
        {
          name: "remote HTTPS",
          resourcePath: (normalizedPath) => `https://remote.example/${normalizedPath}`,
        },
        {
          name: "mismatched app origin",
          resourcePath: (normalizedPath) => `app://obsidian.md/plugins/copilot/${normalizedPath}`,
          trustedLocalOrigin: "app://other.example",
        },
        {
          name: "scheme-relative resource",
          resourcePath: (normalizedPath) => `//remote.example/${normalizedPath}`,
        },
        {
          name: "credentialed resource",
          resourcePath: (normalizedPath) => `app://user:password@obsidian.md/${normalizedPath}`,
        },
        {
          name: "dot-segment resource",
          resourcePath: (normalizedPath) =>
            `app://obsidian.md/plugins/copilot/pdfjs/../${normalizedPath}`,
        },
        {
          name: "encoded traversal resource",
          resourcePath: (normalizedPath) =>
            `app://obsidian.md/plugins/copilot/pdfjs/%2e%2e/${normalizedPath}`,
        },
        {
          name: "encoded separator resource",
          resourcePath: (normalizedPath) =>
            `app://obsidian.md/plugins/copilot/pdfjs/%2f${normalizedPath}`,
        },
        {
          name: "prefix sibling resource",
          resourcePath: (normalizedPath) =>
            normalizedPath === PDF_JS_ASSET_PATHS.worker
              ? "app://obsidian.md/plugins/copilot/pdfjs-sibling/pdf.worker.mjs"
              : `app://obsidian.md/plugins/copilot/${normalizedPath}`,
        },
      ];

      for (const testCase of cases) {
        const harness = createHost(testCase.resourcePath, testCase.trustedLocalOrigin);

        expect(() => createPdfJsLocalParser(harness.host)).toThrow(
          "PDF.js worker configuration is invalid"
        );
        expect(harness.createWorker).not.toHaveBeenCalled();
        expect(pdfWorkerMock).not.toHaveBeenCalled();
        expect(getDocumentMock).not.toHaveBeenCalled();
      }
    });

    it("rejects an untrusted origin before resolving later resources or constructing PDF.js", () => {
      const getResourcePath = jest.fn((normalizedPath: string) => {
        if (normalizedPath === PDF_JS_ASSET_PATHS.api) {
          return "https://remote.example/plugins/copilot/pdfjs/pdf-parser.mjs";
        }
        return `https://remote.example/plugins/copilot/${normalizedPath}`;
      });
      const harness = createHost(getResourcePath, "app://obsidian.md");

      expect(() => createPdfJsLocalParser(harness.host)).toThrow(
        "PDF.js worker configuration is invalid"
      );
      expect(getResourcePath).toHaveBeenCalledTimes(1);
      expect(harness.createWorker).not.toHaveBeenCalled();
      expect(pdfWorkerMock).not.toHaveBeenCalled();
      expect(getDocumentMock).not.toHaveBeenCalled();
    });
  });
});
