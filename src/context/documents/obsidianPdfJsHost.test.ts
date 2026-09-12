import type { LocalPdfParser } from "@/context/documents/pdfTypes";
import type { PdfJsWorkerPort } from "@/context/documents/pdfJsWorkerEngine";
import {
  createObsidianPdfJsParserFactory,
  tryCreateObsidianPdfJsParser,
  type ObsidianPdfJsHostOptions,
} from "@/context/documents/obsidianPdfJsHost";
import type { PdfJsHost } from "@/context/documents/pdfJsHost";
import type { Plugin } from "obsidian";

const PLUGIN_DIRECTORY = "plugins/copilot";
const PDF_API_PATH = "pdfjs/pdf-parser.mjs";
const PDF_WORKER_PATH = "pdfjs/pdf.worker.mjs";
const PDF_FONTS_PATH = "pdfjs/standard_fonts/";
const RESOURCE_PREFIX = "app://obsidian.md/" + PLUGIN_DIRECTORY + "/";

type FixtureOptions = {
  readonly desktop?: boolean;
  readonly manifest?: unknown;
  readonly missingPath?: string;
  readonly resourcePath?: (normalizedPath: string) => string;
};

type Fixture = {
  readonly adapter: {
    readonly exists: jest.Mock;
    readonly read: jest.Mock;
    readonly getResourcePath: jest.Mock;
  };
  readonly createPdfJsLocalParser: jest.Mock;
  readonly loadModule: jest.Mock;
  readonly parser: LocalPdfParser;
  readonly plugin: Pick<Plugin, "app" | "manifest">;
  readonly options: ObsidianPdfJsHostOptions;
};

function createApprovedManifest(): Record<string, unknown> {
  return {
    files: [{ path: "pdf-parser.mjs" }, { path: "pdf.worker.mjs" }, { path: "standard_fonts/" }],
    network: { documentDownload: false, runtimeAssetDownload: false },
    package: {
      license: "Apache-2.0",
      name: "pdfjs-dist",
      version: "6.3.289",
    },
    runtime: {
      byteInputOnly: true,
      fallback: "none",
      standardFonts: "standard_fonts/",
      worker: "pdf.worker.mjs",
      workerRequired: true,
      workerType: "module",
    },
    schemaVersion: 1,
    versionPair: { api: "6.3.289", worker: "6.3.289" },
  };
}

function createFixture(options: FixtureOptions = {}): Fixture {
  const parser: LocalPdfParser = {
    parse: jest.fn(),
  };
  const createPdfJsLocalParser = jest.fn(() => parser);
  const loadModule = jest.fn(async () => ({ createPdfJsLocalParser }));
  const getResourcePath = jest.fn(
    options.resourcePath ??
      ((normalizedPath: string) => RESOURCE_PREFIX + getPluginRelativePath(normalizedPath))
  );
  const exists = jest.fn(
    async (normalizedPath: string) => getPluginRelativePath(normalizedPath) !== options.missingPath
  );
  const read = jest.fn(async () =>
    JSON.stringify(options.manifest === undefined ? createApprovedManifest() : options.manifest)
  );
  const adapter = { exists, getResourcePath, read };
  const plugin = {
    app: { vault: { adapter } },
    manifest: { dir: PLUGIN_DIRECTORY },
  } as unknown as Pick<Plugin, "app" | "manifest">;
  const optionsForHost: ObsidianPdfJsHostOptions = {
    isDesktopRuntime: () => options.desktop ?? true,
    loadModule,
  };

  return {
    adapter,
    createPdfJsLocalParser,
    loadModule,
    options: optionsForHost,
    parser,
    plugin,
  };
}

function getPluginRelativePath(normalizedPath: string): string {
  const prefix = PLUGIN_DIRECTORY + "/";
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : normalizedPath;
}

async function expectBlockedParser(parser: LocalPdfParser | null): Promise<void> {
  expect(parser).not.toBeNull();
  if (!parser) throw new Error("Expected a fail-closed local parser");
  await expect(parser.parse(new Uint8Array())).rejects.toThrow(
    "The packaged local PDF parser is unavailable"
  );
}

describe("obsidianPdfJsHost", () => {
  it("does not inspect or load assets on mobile", async () => {
    const fixture = createFixture({ desktop: false });

    await expect(tryCreateObsidianPdfJsParser(fixture.plugin, fixture.options)).resolves.toBeNull();

    expect(fixture.adapter.exists).not.toHaveBeenCalled();
    expect(fixture.loadModule).not.toHaveBeenCalled();
  });

  it("returns null when the entire optional PDF package is absent", async () => {
    const fixture = createFixture();
    fixture.adapter.exists.mockImplementation(
      async (path: string) => getPluginRelativePath(path) === "main.js"
    );

    await expect(tryCreateObsidianPdfJsParser(fixture.plugin, fixture.options)).resolves.toBeNull();
    expect(fixture.loadModule).not.toHaveBeenCalled();
  });

  it.each([PDF_WORKER_PATH, PDF_API_PATH, PDF_FONTS_PATH, "pdfjs/asset-manifest.json", "main.js"])(
    "blocks legacy fallback when the local package is missing %s",
    async (missingPath) => {
      const fixture = createFixture({ missingPath });
      const parser = await tryCreateObsidianPdfJsParser(fixture.plugin, fixture.options);
      await expectBlockedParser(parser);
      expect(fixture.loadModule).not.toHaveBeenCalled();
    }
  );

  it("rejects a malformed or mismatched asset manifest before module loading", async () => {
    const manifest = createApprovedManifest();
    manifest.versionPair = { api: "6.3.289", worker: "6.3.288" };
    const fixture = createFixture({ manifest });

    const parser = await tryCreateObsidianPdfJsParser(fixture.plugin, fixture.options);
    await expectBlockedParser(parser);

    expect(fixture.loadModule).not.toHaveBeenCalled();
  });

  it("loads a valid package once and passes only verified local resources to the parser", async () => {
    const fixture = createFixture();
    const factory = createObsidianPdfJsParserFactory(fixture.plugin, fixture.options);

    await expect(factory()).resolves.toBe(fixture.parser);
    await expect(factory()).resolves.toBe(fixture.parser);

    expect(fixture.loadModule).toHaveBeenCalledTimes(1);
    expect(fixture.adapter.exists).toHaveBeenCalledTimes(5);
    expect(fixture.loadModule).toHaveBeenCalledWith(RESOURCE_PREFIX + "pdfjs/pdf-parser.mjs");

    const host = fixture.createPdfJsLocalParser.mock.calls[0]?.[0] as PdfJsHost;
    expect(host.trustedLocalOrigin).toBe("app://obsidian.md");
    expect(host.resources.getResourcePath(PDF_API_PATH)).toBe(RESOURCE_PREFIX + PDF_API_PATH);
    expect(host.resources.getResourcePath(PDF_WORKER_PATH)).toBe(RESOURCE_PREFIX + PDF_WORKER_PATH);
    expect(host.resources.getResourcePath(PDF_FONTS_PATH)).toBe(RESOURCE_PREFIX + PDF_FONTS_PATH);
  });

  it("passes the host-owned worker and timer seams through unchanged", async () => {
    const fixture = createFixture();
    const worker = {
      addEventListener: jest.fn(),
      postMessage: jest.fn(),
      removeEventListener: jest.fn(),
      terminate: jest.fn(),
    } as unknown as PdfJsWorkerPort;
    const createWorker = jest.fn(() => worker);
    const setTimeout = jest.fn(() => 1);
    const clearTimeout = jest.fn();

    const options: ObsidianPdfJsHostOptions = {
      ...fixture.options,
      clearTimeout,
      createWorker,
      setTimeout,
    };
    await expect(tryCreateObsidianPdfJsParser(fixture.plugin, options)).resolves.toBe(
      fixture.parser
    );

    const host = fixture.createPdfJsLocalParser.mock.calls[0]?.[0] as PdfJsHost;
    expect(host.runtime.createWorker).toBe(createWorker);
    expect(host.runtime.setTimeout).toBe(setTimeout);
    expect(host.runtime.clearTimeout).toBe(clearTimeout);
  });

  it.each([
    ["remote resource", (path: string) => "https://remote.example/" + getPluginRelativePath(path)],
    [
      "cross-authority app resource",
      (path: string) =>
        getPluginRelativePath(path) === PDF_WORKER_PATH
          ? "app://other.example/" + PLUGIN_DIRECTORY + "/" + PDF_WORKER_PATH
          : RESOURCE_PREFIX + getPluginRelativePath(path),
    ],
    [
      "encoded traversal resource",
      (path: string) =>
        getPluginRelativePath(path) === PDF_WORKER_PATH
          ? RESOURCE_PREFIX + "pdfjs/%2e%2e/" + PDF_WORKER_PATH
          : RESOURCE_PREFIX + getPluginRelativePath(path),
    ],
    [
      "sibling resource",
      (path: string) =>
        getPluginRelativePath(path) === PDF_WORKER_PATH
          ? RESOURCE_PREFIX + "pdfjs-sibling/pdf.worker.mjs"
          : RESOURCE_PREFIX + getPluginRelativePath(path),
    ],
  ])("fails closed for %s", async (_name, resourcePath) => {
    const fixture = createFixture({ resourcePath });

    const parser = await tryCreateObsidianPdfJsParser(fixture.plugin, fixture.options);
    await expectBlockedParser(parser);

    expect(fixture.loadModule).not.toHaveBeenCalled();
    expect(fixture.createPdfJsLocalParser).not.toHaveBeenCalled();
  });

  it("returns a fail-closed parser when the parser module cannot be imported", async () => {
    const fixture = createFixture();
    fixture.loadModule.mockRejectedValueOnce(new Error("module unavailable"));

    const parser = await tryCreateObsidianPdfJsParser(fixture.plugin, fixture.options);
    await expectBlockedParser(parser);

    expect(fixture.createPdfJsLocalParser).not.toHaveBeenCalled();
  });
});
