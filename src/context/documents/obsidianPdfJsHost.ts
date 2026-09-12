import { isDesktopRuntime as defaultIsDesktopRuntime } from "@/utils/desktopRuntime";
import type { PdfJsHost, PdfJsLocalParser } from "@/context/documents/pdfJsHost";
import type { PdfJsWorkerPort } from "@/context/documents/pdfJsWorkerEngine";
import type { Plugin } from "obsidian";

const PDF_API_PATH = "pdfjs/pdf-parser.mjs";
const PDF_WORKER_PATH = "pdfjs/pdf.worker.mjs";
const PDF_MANIFEST_PATH = "pdfjs/asset-manifest.json";
const PDF_FONTS_PATH = "pdfjs/standard_fonts/";
const PLUGIN_MAIN_PATH = "main.js";
const APP_PROTOCOL = "app:";
const REQUIRED_MANIFEST_FILES = new Set(["pdf-parser.mjs", "pdf.worker.mjs", "standard_fonts/"]);

type PdfJsModule = Pick<typeof import("@/context/documents/pdfJsHost"), "createPdfJsLocalParser">;
type PdfJsModuleLoader = (url: string) => Promise<PdfJsModule>;

export interface ObsidianPdfJsHostOptions {
  /** Test seam for platform detection; production uses the desktop runtime guard. */
  readonly isDesktopRuntime?: () => boolean;
  /** Test seam for importing the packaged parser module. */
  readonly loadModule?: PdfJsModuleLoader;
  /** Test seam for constructing a module worker from the packaged worker URL. */
  readonly createWorker?: (assetUrl: URL) => PdfJsWorkerPort;
  /** Test seams for the parser's bounded worker lifecycle timers. */
  readonly setTimeout?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

/**
 * Creates a memoized loader for the optional PDF.js package installed beside
 * the plugin. The standard three-file plugin package has no pdfjs directory,
 * so the factory resolves to null and the caller keeps the existing parser
 * route. A manual package with a complete, matching pdfjs directory gets a
 * byte-only parser without adding PDF.js to the plugin startup bundle.
 */
export function createObsidianPdfJsParserFactory(
  plugin: Pick<Plugin, "app" | "manifest">,
  options: ObsidianPdfJsHostOptions = {}
): () => Promise<PdfJsLocalParser | null> {
  let result: Promise<PdfJsLocalParser | null> | undefined;
  return () => {
    result ??= tryCreateObsidianPdfJsParser(plugin, options);
    return result;
  };
}

/**
 * Probes and loads the complete local PDF.js package from the plugin's own
 * resource directory. A missing package returns null so the caller can retain
 * its existing route; a present but malformed, remote, or cross-origin package
 * returns a fail-closed parser. This function never downloads, substitutes, or
 * falls back to a CDN.
 */
export async function tryCreateObsidianPdfJsParser(
  plugin: Pick<Plugin, "app" | "manifest">,
  options: ObsidianPdfJsHostOptions = {}
): Promise<PdfJsLocalParser | null> {
  const isDesktopRuntime = options.isDesktopRuntime ?? defaultIsDesktopRuntime;
  if (!isDesktopRuntime()) return null;

  const pluginDirectory = normalizePluginDirectory(plugin?.manifest?.dir);
  if (!pluginDirectory) return null;

  const adapter = plugin.app?.vault?.adapter;
  if (
    !adapter ||
    typeof adapter.exists !== "function" ||
    typeof adapter.read !== "function" ||
    typeof adapter.getResourcePath !== "function"
  ) {
    return null;
  }

  const paths = {
    api: joinPluginPath(pluginDirectory, PDF_API_PATH),
    fonts: joinPluginPath(pluginDirectory, PDF_FONTS_PATH),
    main: joinPluginPath(pluginDirectory, PLUGIN_MAIN_PATH),
    manifest: joinPluginPath(pluginDirectory, PDF_MANIFEST_PATH),
    worker: joinPluginPath(pluginDirectory, PDF_WORKER_PATH),
  };
  if (!paths.api || !paths.fonts || !paths.main || !paths.manifest || !paths.worker) {
    return null;
  }

  try {
    const requiredPaths = [paths.api, paths.fonts, paths.main, paths.manifest, paths.worker];
    const existing = await Promise.all(requiredPaths.map((path) => adapter.exists(path)));
    // A partially installed local package must not activate the legacy cloud
    // route. Only a wholly absent PDF package leaves that route available.
    const hasPdfAssets = existing.some((value, index) => index !== 2 && value === true);
    if (!hasPdfAssets) return null;
    if (existing.some((value) => value !== true)) return createUnavailableLocalPdfParser();

    let manifest: unknown;
    try {
      manifest = JSON.parse(await adapter.read(paths.manifest));
    } catch {
      return createUnavailableLocalPdfParser();
    }
    if (!isUsablePdfAssetManifest(manifest)) return createUnavailableLocalPdfParser();

    const mainUrl = parseLocalAppResource(adapter.getResourcePath(paths.main));
    if (!mainUrl) return createUnavailableLocalPdfParser();
    const trustedLocalOrigin = `${mainUrl.protocol}//${mainUrl.host}`;
    const pluginResourcePrefix = getDirectoryPrefix(mainUrl.pathname);
    if (!pluginResourcePrefix) return createUnavailableLocalPdfParser();

    const resourcePaths = new Map<string, string>();
    const resources = [
      [PDF_API_PATH, paths.api],
      [PDF_FONTS_PATH, paths.fonts],
      [PDF_WORKER_PATH, paths.worker],
    ] as const;
    for (const [normalizedPath, vaultPath] of resources) {
      const resourceUrl = parseLocalAppResource(adapter.getResourcePath(vaultPath));
      if (
        !resourceUrl ||
        `${resourceUrl.protocol}//${resourceUrl.host}` !== trustedLocalOrigin ||
        !resourceUrl.pathname.startsWith(`${pluginResourcePrefix}pdfjs/`)
      ) {
        return createUnavailableLocalPdfParser();
      }
      resourcePaths.set(normalizedPath, resourceUrl.href);
    }

    const host: PdfJsHost = {
      trustedLocalOrigin,
      resources: {
        getResourcePath(normalizedPath) {
          const resourcePath = resourcePaths.get(normalizedPath);
          if (!resourcePath) throw new Error("Unknown local PDF asset");
          return resourcePath;
        },
      },
      runtime: {
        createWorker: options.createWorker ?? createModuleWorker,
        setTimeout:
          options.setTimeout ??
          ((callback, milliseconds) => window.setTimeout(callback, milliseconds)),
        clearTimeout: options.clearTimeout ?? ((handle) => window.clearTimeout(handle as number)),
      },
    };

    const loadModule = options.loadModule ?? loadPackagedPdfJsModule;
    const module = await loadModule(resourcePaths.get(PDF_API_PATH) ?? "");
    if (!module || typeof module.createPdfJsLocalParser !== "function") {
      return createUnavailableLocalPdfParser();
    }
    return module.createPdfJsLocalParser(host);
  } catch {
    return createUnavailableLocalPdfParser();
  }
}

function normalizePluginDirectory(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/")
  ) {
    return null;
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }
  return value;
}

function joinPluginPath(pluginDirectory: string, relativePath: string): string | null {
  if (
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    return null;
  }
  return `${pluginDirectory}/${relativePath}`;
}

function parseLocalAppResource(value: unknown): URL | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /\s/.test(value) ||
    hasUnsafeRawPath(value)
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== APP_PROTOCOL ||
    url.host.length === 0 ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    hasUnsafePath(url.pathname)
  ) {
    return null;
  }
  return url;
}

function hasUnsafePath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  if (lower.includes("%2f") || lower.includes("%5c") || lower.includes("%2e")) return true;
  try {
    const decoded = decodeURIComponent(pathname);
    return (
      decoded.includes("\\") ||
      decoded.split("/").some((segment) => segment === "." || segment === "..")
    );
  } catch {
    return true;
  }
}

function hasUnsafeRawPath(value: string): boolean {
  const schemeSeparator = value.indexOf("://");
  if (schemeSeparator < 0) return true;
  const authorityStart = schemeSeparator + 3;
  const pathStart = value.indexOf("/", authorityStart);
  const suffixStart = [value.indexOf("?", authorityStart), value.indexOf("#", authorityStart)]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const rawPath =
    pathStart < 0
      ? ""
      : value.slice(pathStart, suffixStart === undefined ? value.length : suffixStart);
  return (
    !rawPath.startsWith("/") ||
    /%2e|%2f|%5c|%00/i.test(rawPath) ||
    /(^|\/)\.{1,2}(?:\/|$)/.test(rawPath)
  );
}

function getDirectoryPrefix(pathname: string): string | null {
  const separator = pathname.lastIndexOf("/");
  return separator < 1 ? null : pathname.slice(0, separator + 1);
}

function isUsablePdfAssetManifest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== 1 ||
    !isRecord(value.package) ||
    value.package.name !== "pdfjs-dist" ||
    value.package.license !== "Apache-2.0" ||
    typeof value.package.version !== "string" ||
    !isRecord(value.versionPair) ||
    typeof value.versionPair.api !== "string" ||
    value.versionPair.api.length === 0 ||
    value.package.version !== value.versionPair.api ||
    value.versionPair.worker !== value.versionPair.api ||
    !isRecord(value.runtime) ||
    value.runtime.byteInputOnly !== true ||
    value.runtime.workerRequired !== true ||
    value.runtime.workerType !== "module" ||
    value.runtime.fallback !== "none" ||
    value.runtime.worker !== "pdf.worker.mjs" ||
    value.runtime.standardFonts !== "standard_fonts/" ||
    !isRecord(value.network) ||
    value.network.documentDownload !== false ||
    value.network.runtimeAssetDownload !== false ||
    !Array.isArray(value.files)
  ) {
    return false;
  }

  const files = new Set<string>();
  for (const entry of value.files) {
    if (!isRecord(entry) || typeof entry.path !== "string" || !isSafeManifestPath(entry.path)) {
      return false;
    }
    files.add(entry.path);
  }
  return [...REQUIRED_MANIFEST_FILES].every((path) => files.has(path));
}

function isSafeManifestPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createUnavailableLocalPdfParser(): PdfJsLocalParser {
  return Object.freeze({
    parse: async () => {
      throw new Error("The packaged local PDF parser is unavailable");
    },
  });
}

async function loadPackagedPdfJsModule(url: string): Promise<PdfJsModule> {
  // The URL is produced by the validated app:// resource resolver above; it
  // never comes from user input or a remote network source.
  // eslint-disable-next-line no-unsanitized/method -- validated local app resource URL
  return (await import(url)) as PdfJsModule;
}

function createModuleWorker(assetUrl: URL): PdfJsWorkerPort {
  if (typeof window.Worker !== "function") {
    throw new Error("Module workers are unavailable");
  }
  return new window.Worker(assetUrl.href, { type: "module" });
}
