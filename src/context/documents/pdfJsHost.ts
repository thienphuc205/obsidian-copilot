import { getDocument, PDFWorker, version as pdfJsVersion } from "pdfjs-dist";

import { parseLocalPdf } from "@/context/documents/localPdfParser";
import {
  createPdfJsWorkerEngine,
  PdfJsWorkerEngineError,
  type PdfJsApi,
  type PdfJsWorkerPort,
} from "@/context/documents/pdfJsWorkerEngine";
import type {
  LocalPdfParseOptions,
  LocalPdfParser,
  LocalPdfParserEngine,
} from "@/context/documents/pdfTypes";

const SUPPORTED_RESOURCE_PROTOCOLS = new Set(["app:", "http:", "https:"]);
const LOOPBACK_PROTOCOLS = new Set(["http:", "https:"]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** Stable asset names emitted by the dedicated PDF package build. */
export const PDF_JS_ASSET_PATHS = Object.freeze({
  api: "pdfjs/pdf-parser.mjs",
  standardFonts: "pdfjs/standard_fonts/",
  worker: "pdfjs/pdf.worker.mjs",
});

/** The version that must be paired with the emitted API and worker assets. */
export const PDF_JS_VERSION = pdfJsVersion;

/** Plugin-owned resource URL resolver used for packaged PDF assets. */
export interface PdfJsHostResources {
  getResourcePath(normalizedPath: string): string;
}

/** Host capabilities required to create one explicit PDF.js worker. */
export interface PdfJsHostRuntime {
  createWorker(assetUrl: URL): PdfJsWorkerPort;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Injected plugin resource and worker capabilities for the local PDF parser. */
export interface PdfJsHost {
  /** Origin independently verified by the host as the local app or loopback asset origin. */
  readonly trustedLocalOrigin: string;
  readonly resources: PdfJsHostResources;
  readonly runtime: PdfJsHostRuntime;
}

/** Byte-only parser facade composed from the packaged PDF.js API and worker. */
export type PdfJsLocalParser = LocalPdfParser;

/**
 * Composes the packaged PDF.js API with a caller-owned local worker factory.
 *
 * Resource URLs must come from the injected plugin resolver and match the
 * separately trusted local origin. App resources must match the exact app
 * authority; HTTP(S) is allowed only for an explicitly supplied loopback test
 * origin. The parser never falls back to a remote or CDN asset.
 *
 * @param host Plugin resource resolver, worker factory, and timer primitives.
 * @returns A parser that accepts only caller-provided PDF bytes.
 */
export function createPdfJsLocalParser(host: PdfJsHost): PdfJsLocalParser {
  validateHost(host);
  const trustedLocalOrigin = parseTrustedLocalOrigin(host.trustedLocalOrigin);

  const apiUrl = resolveResource(host.resources, PDF_JS_ASSET_PATHS.api, trustedLocalOrigin);
  const workerUrl = resolveResource(host.resources, PDF_JS_ASSET_PATHS.worker, trustedLocalOrigin);
  const fontUrl = resolveResource(
    host.resources,
    PDF_JS_ASSET_PATHS.standardFonts,
    trustedLocalOrigin
  );
  const assetPrefix = getDirectoryPrefix(apiUrl.pathname);
  validateAssetPair(apiUrl, workerUrl, fontUrl, assetPrefix, trustedLocalOrigin);

  const api: PdfJsApi = {
    getDocument: getDocument as unknown as PdfJsApi["getDocument"],
    PDFWorker: PDFWorker as unknown as PdfJsApi["PDFWorker"],
    version: PDF_JS_VERSION,
  };
  const engine: LocalPdfParserEngine = createPdfJsWorkerEngine(
    api,
    { createWorker: (assetUrl) => host.runtime.createWorker(assetUrl) },
    {
      baseUrl: apiUrl.href,
      clearTimeout: (handle) => host.runtime.clearTimeout(handle),
      origin: apiUrl.origin,
      setTimeout: (callback, milliseconds) => host.runtime.setTimeout(callback, milliseconds),
    },
    {
      allowedAssetPathPrefixes: [assetPrefix],
      expectedApiVersion: PDF_JS_VERSION,
      expectedWorkerVersion: PDF_JS_VERSION,
      standardFontDataPath: fontUrl.href,
      workerAssetPath: workerUrl.href,
    }
  );

  return Object.freeze({
    parse: (bytes: Uint8Array, options?: LocalPdfParseOptions) =>
      parseLocalPdf(bytes, engine, options),
  });
}

function validateHost(host: PdfJsHost): void {
  if (
    !host ||
    typeof host.trustedLocalOrigin !== "string" ||
    !host.resources ||
    typeof host.resources.getResourcePath !== "function" ||
    !host.runtime ||
    typeof host.runtime.createWorker !== "function" ||
    typeof host.runtime.setTimeout !== "function" ||
    typeof host.runtime.clearTimeout !== "function"
  ) {
    throw new PdfJsWorkerEngineError("invalid-configuration");
  }
}

function parseTrustedLocalOrigin(value: string): URL {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new PdfJsWorkerEngineError("invalid-configuration");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PdfJsWorkerEngineError("invalid-configuration");
  }
  if (
    !SUPPORTED_RESOURCE_PROTOCOLS.has(url.protocol) ||
    url.host.length === 0 ||
    url.username !== "" ||
    url.password !== "" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== "" ||
    value.includes("\\") ||
    /\s/.test(value) ||
    value.startsWith("//")
  ) {
    throw new PdfJsWorkerEngineError("invalid-configuration");
  }
  if (url.protocol === "app:") {
    return url;
  }
  if (LOOPBACK_PROTOCOLS.has(url.protocol) && isLoopbackHostname(url.hostname)) {
    return url;
  }
  throw new PdfJsWorkerEngineError("invalid-configuration");
}

function resolveResource(
  resources: PdfJsHostResources,
  normalizedPath: string,
  trustedLocalOrigin: URL
): URL {
  let value: string;
  try {
    value = resources.getResourcePath(normalizedPath);
  } catch {
    throw new PdfJsWorkerEngineError("invalid-configuration");
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /\s/.test(value) ||
    hasUnsafeRawPath(value)
  ) {
    throw new PdfJsWorkerEngineError("invalid-configuration");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PdfJsWorkerEngineError("invalid-configuration");
  }
  if (
    !SUPPORTED_RESOURCE_PROTOCOLS.has(url.protocol) ||
    url.host.length === 0 ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new PdfJsWorkerEngineError("invalid-configuration");
  }
  if (!isTrustedLocalResource(url, trustedLocalOrigin) || hasUnsafePath(url.pathname)) {
    throw new PdfJsWorkerEngineError("invalid-configuration");
  }
  return url;
}

function validateAssetPair(
  apiUrl: URL,
  workerUrl: URL,
  fontUrl: URL,
  assetPrefix: string,
  trustedLocalOrigin: URL
): void {
  const apiIdentity = `${apiUrl.protocol}//${apiUrl.host}`;
  if (
    !isTrustedLocalResource(apiUrl, trustedLocalOrigin) ||
    !isTrustedLocalResource(workerUrl, trustedLocalOrigin) ||
    !isTrustedLocalResource(fontUrl, trustedLocalOrigin)
  ) {
    throw new PdfJsWorkerEngineError("invalid-configuration");
  }
  for (const assetUrl of [workerUrl, fontUrl]) {
    if (
      `${assetUrl.protocol}//${assetUrl.host}` !== apiIdentity ||
      hasUnsafePath(assetUrl.pathname) ||
      !isPathWithinDirectory(assetUrl.pathname, assetPrefix)
    ) {
      throw new PdfJsWorkerEngineError("invalid-configuration");
    }
  }
  if (!fontUrl.pathname.endsWith("/")) {
    throw new PdfJsWorkerEngineError("invalid-configuration");
  }
}

function getDirectoryPrefix(pathname: string): string {
  const separator = pathname.lastIndexOf("/");
  if (separator < 1) {
    throw new PdfJsWorkerEngineError("invalid-configuration");
  }
  return pathname.slice(0, separator + 1);
}

function isTrustedLocalResource(url: URL, trustedLocalOrigin: URL): boolean {
  if (url.protocol !== trustedLocalOrigin.protocol) {
    return false;
  }
  if (
    `${url.protocol}//${url.host}` !== `${trustedLocalOrigin.protocol}//${trustedLocalOrigin.host}`
  ) {
    return false;
  }
  return url.protocol === "app:" || isLoopbackHostname(url.hostname);
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.replace(/^\[|\]$/g, "").toLowerCase());
}

function isPathWithinDirectory(pathname: string, directory: string): boolean {
  return pathname.startsWith(directory) && pathname.length > directory.length;
}

function hasUnsafePath(pathname: string): boolean {
  return hasUnsafeDecodedPath(pathname);
}

function hasUnsafeRawPath(value: string): boolean {
  const schemeSeparator = value.indexOf("://");
  if (schemeSeparator < 0) {
    return true;
  }
  const authorityStart = schemeSeparator + 3;
  const pathStart = value.indexOf("/", authorityStart);
  const queryStart = value.indexOf("?", authorityStart);
  const hashStart = value.indexOf("#", authorityStart);
  const firstSuffix = [pathStart, queryStart, hashStart]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const suffixStart =
    [queryStart, hashStart].filter((index) => index >= 0).sort((left, right) => left - right)[0] ??
    value.length;
  const rawPath =
    firstSuffix === undefined || firstSuffix !== pathStart
      ? "/"
      : value.slice(pathStart, suffixStart);
  if (!rawPath.startsWith("/") || /%2f|%5c|%00/i.test(rawPath)) {
    return true;
  }
  return hasUnsafeDecodedPath(rawPath);
}

function hasUnsafeDecodedPath(pathname: string): boolean {
  let decoded = pathname;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (/%2e|%2f|%5c|%00/i.test(decoded)) {
      return true;
    }
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return true;
    }
    if (next === decoded) {
      break;
    }
    decoded = next;
  }
  return (
    /%2e|%2f|%5c|%00/i.test(decoded) ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.split("/").some((segment) => segment === "." || segment === "..")
  );
}
