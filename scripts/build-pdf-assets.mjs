import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build, version as esbuildVersion } from "esbuild";

const EXPECTED_PDFJS_VERSION = "6.3.289";
const PDF_ASSET_DIRECTORY = "pdfjs";
const PDF_API_FILE = "pdf-parser.mjs";
const PDF_WORKER_FILE = "pdf.worker.mjs";
const PDF_MANIFEST_FILE = "asset-manifest.json";
const REQUIRED_FONT_EXTENSIONS = new Set([".pfb", ".ttf"]);
const REQUIRED_FONT_LICENSES = ["LICENSE_FOXIT", "LICENSE_LIBERATION"];

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Build-time locations and version policy for the local PDF package. */
export const PDF_ASSET_BUILD = Object.freeze({
  apiFile: PDF_API_FILE,
  assetDirectory: PDF_ASSET_DIRECTORY,
  manifestFile: PDF_MANIFEST_FILE,
  version: EXPECTED_PDFJS_VERSION,
  workerFile: PDF_WORKER_FILE,
});

/**
 * Builds the lazy local PDF.js module, worker, fonts, notices, and manifest.
 *
 * The output is separate from the main plugin bundle so a PDF parser is never
 * evaluated merely because the plugin starts. The input package is checked for
 * the exact reviewed version before any output is produced.
 *
 * @param options Repository and output locations used by the build.
 * @returns The verified asset manifest.
 */
export async function buildPdfAssets(options = {}) {
  const repositoryRoot = resolve(options.repositoryRoot ?? scriptRoot);
  const outputRoot = resolve(options.outputRoot ?? join(repositoryRoot, PDF_ASSET_DIRECTORY));
  const packageRoot = join(repositoryRoot, "node_modules", "pdfjs-dist");
  const packageJson = await readJson(join(packageRoot, "package.json"));
  assertReviewedPackage(packageJson);
  const packageIntegrity = await readPackageIntegrity(repositoryRoot);

  await prepareOutput(outputRoot);
  await buildApiModule(repositoryRoot, join(outputRoot, PDF_API_FILE));
  await copyRequiredWorker(packageRoot, join(outputRoot, PDF_WORKER_FILE));
  await copyRequiredFonts(packageRoot, outputRoot);
  await copyRequiredLicenses(packageRoot, outputRoot);

  const manifest = await createAssetManifest({
    outputRoot,
    packageIntegrity,
    packageJson,
  });
  await writeFile(
    join(outputRoot, PDF_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  await verifyPdfAssetPackage({ outputRoot, expectedVersion: EXPECTED_PDFJS_VERSION });
  return manifest;
}

/**
 * Verifies a generated PDF package before a host can use its asset paths.
 *
 * @param options Output directory and expected PDF.js version.
 * @returns The parsed manifest after all listed files pass their checksums.
 */
export async function verifyPdfAssetPackage(options) {
  const outputRoot = resolve(options.outputRoot);
  const expectedVersion = options.expectedVersion ?? EXPECTED_PDFJS_VERSION;
  const manifest = await readJson(join(outputRoot, PDF_MANIFEST_FILE));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.package?.name !== "pdfjs-dist" ||
    manifest.package?.version !== expectedVersion ||
    manifest.versionPair?.api !== expectedVersion ||
    manifest.versionPair?.worker !== expectedVersion
  ) {
    throw new Error("PDF asset manifest is not an approved version pair");
  }
  if (
    manifest.runtime?.workerType !== "module" ||
    manifest.runtime?.workerRequired !== true ||
    manifest.runtime?.fallback !== "none"
  ) {
    throw new Error("PDF asset manifest permits an unsupported worker fallback");
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("PDF asset manifest has no files");
  }

  const listedPaths = new Set();
  for (const entry of manifest.files) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      entry.path === PDF_MANIFEST_FILE ||
      entry.path.startsWith("/") ||
      entry.path.includes("\\") ||
      entry.path.split("/").includes("..") ||
      listedPaths.has(entry.path)
    ) {
      throw new Error("PDF asset manifest contains an invalid file path");
    }
    listedPaths.add(entry.path);
    const filePath = join(outputRoot, entry.path);
    const contents = await readFile(filePath);
    const bytes = contents.byteLength;
    const sha256 = createHash("sha256").update(contents).digest("hex");
    if (entry.bytes !== bytes || entry.sha256 !== sha256) {
      throw new Error(`PDF asset checksum mismatch: ${entry.path}`);
    }
    if (entry.path.includes("/wasm/") || entry.path.includes("/cmaps/")) {
      throw new Error(`Unsupported PDF asset included: ${entry.path}`);
    }
  }

  const actualPaths = (await collectFiles(outputRoot))
    .map(({ path }) => path)
    .filter((path) => path !== PDF_MANIFEST_FILE);
  if (
    actualPaths.length !== listedPaths.size ||
    actualPaths.some((path) => !listedPaths.has(path))
  ) {
    throw new Error("PDF asset directory contains an unmanifested file");
  }

  const apiPath = join(outputRoot, PDF_API_FILE);
  const workerPath = join(outputRoot, PDF_WORKER_FILE);
  const [apiSource, workerSource] = await Promise.all([
    readFile(apiPath, "utf8"),
    readFile(workerPath, "utf8"),
  ]);
  if (!apiSource.includes(expectedVersion) || !workerSource.includes(expectedVersion)) {
    throw new Error("PDF API and worker do not contain the approved version");
  }
  return manifest;
}

async function buildApiModule(repositoryRoot, outputPath) {
  await build({
    absWorkingDir: repositoryRoot,
    alias: { "@": join(repositoryRoot, "src") },
    bundle: true,
    entryPoints: [join(repositoryRoot, "src/context/documents/pdfJsHost.ts")],
    format: "esm",
    legalComments: "eof",
    minify: true,
    outfile: outputPath,
    platform: "browser",
    sourcemap: false,
    target: "es2020",
  });
}

async function copyRequiredWorker(packageRoot, destination) {
  await copyFileChecked(join(packageRoot, "build", "pdf.worker.mjs"), destination);
}

async function copyRequiredFonts(packageRoot, outputRoot) {
  const sourceRoot = join(packageRoot, "standard_fonts");
  const destinationRoot = join(outputRoot, "standard_fonts");
  await mkdir(destinationRoot, { recursive: true });
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const fontEntries = entries.filter(
    (entry) => entry.isFile() && REQUIRED_FONT_EXTENSIONS.has(getExtension(entry.name))
  );
  if (fontEntries.length === 0) {
    throw new Error("PDF.js standard font package is empty");
  }
  for (const entry of fontEntries) {
    await copyFileChecked(join(sourceRoot, entry.name), join(destinationRoot, entry.name));
  }
}

async function copyRequiredLicenses(packageRoot, outputRoot) {
  const destinationRoot = join(outputRoot, "licenses");
  await mkdir(join(destinationRoot, "pdfjs"), { recursive: true });
  await mkdir(join(destinationRoot, "standard_fonts"), { recursive: true });
  await copyFileChecked(join(packageRoot, "LICENSE"), join(destinationRoot, "pdfjs", "LICENSE"));
  for (const filename of REQUIRED_FONT_LICENSES) {
    await copyFileChecked(
      join(packageRoot, "standard_fonts", filename),
      join(destinationRoot, "standard_fonts", filename)
    );
  }
}

async function createAssetManifest({ outputRoot, packageIntegrity, packageJson }) {
  const files = await collectFiles(outputRoot);
  const apiSource = await readFile(join(outputRoot, PDF_API_FILE), "utf8");
  const workerSource = await readFile(join(outputRoot, PDF_WORKER_FILE), "utf8");
  if (!apiSource.includes(packageJson.version) || !workerSource.includes(packageJson.version)) {
    throw new Error("PDF.js API and worker version markers do not match the package");
  }

  return {
    schemaVersion: 1,
    package: {
      integrity: packageIntegrity,
      license: packageJson.license,
      name: packageJson.name,
      version: packageJson.version,
    },
    versionPair: {
      api: packageJson.version,
      worker: packageJson.version,
    },
    runtime: {
      byteInputOnly: true,
      fallback: "none",
      standardFonts: "standard_fonts/",
      worker: PDF_WORKER_FILE,
      workerRequired: true,
      workerType: "module",
    },
    build: {
      bundler: "esbuild",
      bundlerVersion: esbuildVersion,
      target: "es2020",
      minify: true,
      sourcemap: false,
    },
    network: {
      documentDownload: false,
      runtimeAssetDownload: false,
    },
    excluded: ["cmaps", "image_decoders", "wasm", "@napi-rs/canvas"],
    files,
  };
}

async function prepareOutput(outputRoot) {
  await mkdir(outputRoot, { recursive: true });
  const managedEntries = new Set([
    PDF_API_FILE,
    PDF_MANIFEST_FILE,
    PDF_WORKER_FILE,
    "licenses",
    "standard_fonts",
  ]);
  const unexpectedEntries = (await readdir(outputRoot, { withFileTypes: true }))
    .map((entry) => entry.name)
    .filter((name) => !managedEntries.has(name));
  if (unexpectedEntries.length > 0) {
    throw new Error(
      `PDF asset directory contains unexpected entries: ${unexpectedEntries.join(", ")}`
    );
  }
  await Promise.all([
    rm(join(outputRoot, PDF_API_FILE), { force: true }),
    rm(join(outputRoot, PDF_WORKER_FILE), { force: true }),
    rm(join(outputRoot, PDF_MANIFEST_FILE), { force: true }),
    rm(join(outputRoot, "standard_fonts"), { force: true, recursive: true }),
    rm(join(outputRoot, "licenses"), { force: true, recursive: true }),
  ]);
}

async function copyFileChecked(source, destination) {
  const sourceStats = await stat(source);
  if (!sourceStats.isFile()) {
    throw new Error(`Required PDF asset is not a file: ${source}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination);
}

async function collectFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, absolutePath)));
    } else if (entry.isFile()) {
      const contents = await readFile(absolutePath);
      files.push({
        bytes: contents.byteLength,
        path: relative(root, absolutePath).split(sep).join("/"),
        sha256: createHash("sha256").update(contents).digest("hex"),
      });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error(`Could not read JSON metadata: ${filePath}`);
  }
}

async function readPackageIntegrity(repositoryRoot) {
  const lock = await readJson(join(repositoryRoot, "package-lock.json"));
  const integrity = lock.packages?.["node_modules/pdfjs-dist"]?.integrity;
  if (typeof integrity !== "string" || integrity.length === 0) {
    throw new Error("package-lock.json does not pin pdfjs-dist integrity");
  }
  return integrity;
}

function assertReviewedPackage(packageJson) {
  if (
    packageJson?.name !== "pdfjs-dist" ||
    packageJson.version !== EXPECTED_PDFJS_VERSION ||
    packageJson.license !== "Apache-2.0"
  ) {
    throw new Error("Installed PDF.js package is not the reviewed exact candidate");
  }
}

function getExtension(filename) {
  const separator = filename.lastIndexOf(".");
  return separator < 0 ? "" : filename.slice(separator).toLowerCase();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const manifest = await buildPdfAssets();
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "PDF asset build failed"}\n`);
    process.exitCode = 1;
  }
}
