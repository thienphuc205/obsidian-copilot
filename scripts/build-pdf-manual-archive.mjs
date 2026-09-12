import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { PDF_ASSET_BUILD, verifyPdfAssetPackage } from "./build-pdf-assets.mjs";

const execFile = promisify(execFileCallback);
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARCHIVE_SCHEMA_VERSION = 1;
const ROOT_PLUGIN_FILES = Object.freeze(["main.js", "manifest.json", "styles.css"]);
const ZIP_EPOCH = new Date("1980-01-01T00:00:00.000Z");

/** Manual package inputs and the receipt contract required before archiving. */
export const PDF_MANUAL_ARCHIVE = Object.freeze({
  archiveSchemaVersion: ARCHIVE_SCHEMA_VERSION,
  assetDirectory: PDF_ASSET_BUILD.assetDirectory,
  rootPluginFiles: ROOT_PLUGIN_FILES,
  receiptArtifactKind: "obsidian-plugin-main",
  receiptSchemaVersion: 1,
});

/**
 * Packages a clean main artifact with the verified, version-paired PDF assets.
 *
 * The receipt is an explicit handoff from a successful clean main build. This
 * function refuses to infer success from files that merely happen to be in the
 * repository root.
 *
 * @param options Archive input, output, and receipt paths.
 * @returns The sidecar manifest for the deterministic archive.
 */
export async function buildPdfManualArchive(options) {
  const artifactRoot = resolveRequiredPath(options?.pluginArtifactRoot, "plugin artifact root");
  const receiptPath = resolveRequiredPath(
    options?.mainArtifactReceiptPath,
    "main artifact receipt"
  );
  const outputPath = resolveRequiredPath(options?.outputPath, "archive output");
  const pdfAssetRoot = resolve(options?.pdfAssetRoot ?? join(scriptRoot, "pdfjs"));
  const manifestPath = resolve(options?.manifestPath ?? `${outputPath}.manifest.json`);

  const receipt = await readJson(receiptPath, "main artifact receipt");
  assertCleanArtifactReceipt(receipt, artifactRoot);
  const mainFiles = await readRequiredPluginFiles(artifactRoot);
  assertReceiptMatchesFiles(receipt, mainFiles);
  const pdfManifest = await verifyPdfAssetPackage({
    expectedVersion: PDF_ASSET_BUILD.version,
    outputRoot: pdfAssetRoot,
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await mkdir(dirname(manifestPath), { recursive: true });
  const stagingRoot = await mkdtemp(join(dirname(outputPath), ".pdf-manual-archive-"));
  try {
    await copyRequiredPluginFiles(artifactRoot, stagingRoot);
    await copyTreeChecked(pdfAssetRoot, join(stagingRoot, PDF_ASSET_BUILD.assetDirectory));
    const stagedFiles = await collectFiles(stagingRoot);
    assertExpectedArchiveFiles(stagedFiles);
    await normalizeFileTimes(stagingRoot, stagedFiles);
    await rm(outputPath, { force: true });
    await createZip(outputPath, stagingRoot, stagedFiles);

    const archiveBytes = await readFile(outputPath);
    const archiveManifest = {
      archive: {
        bytes: archiveBytes.byteLength,
        sha256: sha256(archiveBytes),
      },
      archiveSchemaVersion: ARCHIVE_SCHEMA_VERSION,
      distribution: "manual-experimental",
      files: stagedFiles,
      mainArtifactReceipt: receipt,
      pdf: {
        assetManifestSha256: sha256(
          await readFile(join(pdfAssetRoot, PDF_ASSET_BUILD.manifestFile))
        ),
        package: pdfManifest.package,
        versionPair: pdfManifest.versionPair,
      },
      routes: {
        standardUpdaterIncludesArchive: false,
        manualCopyRequired: true,
      },
    };
    await writeFile(manifestPath, `${JSON.stringify(archiveManifest, null, 2)}\n`, "utf8");
    await verifyPdfManualArchive({
      archivePath: outputPath,
      expectedManifest: archiveManifest,
    });
    return archiveManifest;
  } finally {
    await rm(stagingRoot, { force: true, recursive: true });
  }
}

/**
 * Unpacks and verifies a manual archive without trusting its file names or
 * hashes. The verified PDF asset manifest is checked again after extraction.
 *
 * @param options Archive path and optional expected sidecar manifest.
 * @returns The verified sidecar manifest.
 */
export async function verifyPdfManualArchive(options) {
  const archivePath = resolveRequiredPath(options?.archivePath, "archive");
  const expectedManifest =
    options?.expectedManifest ??
    (await readJson(
      options?.manifestPath ?? `${archivePath}.manifest.json`,
      "manual archive manifest"
    ));
  assertArchiveManifest(expectedManifest);

  const archiveEntries = await listArchiveEntries(archivePath);
  assertSafeArchiveEntries(archiveEntries);
  const expectedPaths = expectedManifest.files.map((entry) => entry.path);
  assertSamePaths(
    archiveEntries.filter((entry) => !entry.endsWith("/")),
    expectedPaths
  );
  const archiveBytes = await readFile(archivePath);
  if (
    expectedManifest.archive.bytes !== archiveBytes.byteLength ||
    expectedManifest.archive.sha256 !== sha256(archiveBytes)
  ) {
    throw new Error("Manual archive checksum does not match its manifest");
  }

  const unpackRoot = await mkdtemp(join(dirname(archivePath), ".pdf-manual-unpack-"));
  try {
    await execFile("unzip", ["-q", archivePath, "-d", unpackRoot]);
    const unpackedFiles = await collectFiles(unpackRoot);
    assertExpectedArchiveFiles(unpackedFiles);
    assertSamePaths(
      unpackedFiles.map((entry) => entry.path),
      expectedPaths
    );
    for (const expectedFile of expectedManifest.files) {
      const actualFile = unpackedFiles.find((entry) => entry.path === expectedFile.path);
      if (
        !actualFile ||
        actualFile.bytes !== expectedFile.bytes ||
        actualFile.sha256 !== expectedFile.sha256
      ) {
        throw new Error(`Manual archive checksum mismatch: ${expectedFile.path}`);
      }
    }
    const pdfManifest = await verifyPdfAssetPackage({
      expectedVersion: PDF_ASSET_BUILD.version,
      outputRoot: join(unpackRoot, PDF_ASSET_BUILD.assetDirectory),
    });
    if (
      sha256(
        await readFile(
          join(unpackRoot, PDF_ASSET_BUILD.assetDirectory, PDF_ASSET_BUILD.manifestFile)
        )
      ) !== expectedManifest.pdf.assetManifestSha256
    ) {
      throw new Error("Manual archive PDF asset manifest checksum mismatch");
    }
    if (pdfManifest.versionPair?.api !== PDF_ASSET_BUILD.version) {
      throw new Error("Manual archive contains an unapproved PDF version pair");
    }
    return expectedManifest;
  } finally {
    await rm(unpackRoot, { force: true, recursive: true });
  }
}

async function readRequiredPluginFiles(artifactRoot) {
  const files = [];
  for (const path of ROOT_PLUGIN_FILES) {
    const filePath = join(artifactRoot, path);
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Main artifact is not a regular file: ${path}`);
    }
    const contents = await readFile(filePath);
    files.push(fileEntry(path, contents));
  }
  return files;
}

async function copyRequiredPluginFiles(artifactRoot, stagingRoot) {
  for (const path of ROOT_PLUGIN_FILES) {
    await cp(join(artifactRoot, path), join(stagingRoot, path));
  }
}

async function copyTreeChecked(sourceRoot, destinationRoot, current = sourceRoot) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const sourcePath = join(current, entry.name);
    const relativePath = relative(sourceRoot, sourcePath).split(sep).join("/");
    assertSafeArchivePath(relativePath);
    const destinationPath = join(destinationRoot, relativePath);
    if (entry.isSymbolicLink()) {
      throw new Error(`PDF asset tree contains a symbolic link: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      await mkdir(destinationPath, { recursive: true });
      await copyTreeChecked(sourceRoot, destinationRoot, sourcePath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`PDF asset tree contains a non-file entry: ${relativePath}`);
    }
    await mkdir(dirname(destinationPath), { recursive: true });
    await cp(sourcePath, destinationPath);
  }
}

async function collectFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = join(current, entry.name);
    const path = relative(root, absolutePath).split(sep).join("/");
    assertSafeArchivePath(path);
    if (entry.isSymbolicLink()) {
      throw new Error(`Archive tree contains a symbolic link: ${path}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, absolutePath)));
    } else if (entry.isFile()) {
      files.push(fileEntry(path, await readFile(absolutePath)));
    } else {
      throw new Error(`Archive tree contains a non-file entry: ${path}`);
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function fileEntry(path, contents) {
  return {
    bytes: contents.byteLength,
    path,
    sha256: sha256(contents),
  };
}

async function normalizeFileTimes(root, files) {
  await Promise.all(files.map(({ path }) => utimes(join(root, path), ZIP_EPOCH, ZIP_EPOCH)));
}

async function createZip(outputPath, stagingRoot, files) {
  try {
    await execFile("zip", ["-X", "-D", "-q", outputPath, ...files.map((file) => file.path)], {
      cwd: stagingRoot,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `Could not create the manual PDF archive with the host zip tool: ${
        error instanceof Error ? error.message : "zip failed"
      }`
    );
  }
}

async function listArchiveEntries(archivePath) {
  try {
    const result = await execFile("unzip", ["-Z1", archivePath], { maxBuffer: 1024 * 1024 });
    return result.stdout.split(/\r?\n/).filter((entry) => entry.length > 0);
  } catch (error) {
    throw new Error(
      `Could not inspect the manual PDF archive with the host unzip tool: ${
        error instanceof Error ? error.message : "unzip failed"
      }`
    );
  }
}

function assertCleanArtifactReceipt(receipt, artifactRoot) {
  if (
    receipt?.schemaVersion !== PDF_MANUAL_ARCHIVE.receiptSchemaVersion ||
    receipt?.artifactKind !== PDF_MANUAL_ARCHIVE.receiptArtifactKind ||
    receipt?.status !== "success" ||
    receipt?.source?.clean !== true ||
    receipt?.artifactRoot !== artifactRoot
  ) {
    throw new Error(
      "Manual PDF archive requires a successful clean main-artifact receipt for the exact input root"
    );
  }
}

function assertReceiptMatchesFiles(receipt, actualFiles) {
  const receiptFiles = receipt.files;
  if (!receiptFiles || typeof receiptFiles !== "object") {
    throw new Error("Main artifact receipt has no file hashes");
  }
  const receiptPaths = Object.keys(receiptFiles).sort();
  const actualPaths = actualFiles.map((file) => file.path).sort();
  assertSamePaths(receiptPaths, actualPaths);
  for (const actualFile of actualFiles) {
    const expected = receiptFiles[actualFile.path];
    if (!expected || expected.bytes !== actualFile.bytes || expected.sha256 !== actualFile.sha256) {
      throw new Error(`Main artifact receipt checksum mismatch: ${actualFile.path}`);
    }
  }
}

function assertExpectedArchiveFiles(files) {
  const expectedRootFiles = new Set(ROOT_PLUGIN_FILES);
  const expectedPaths = files.map((file) => file.path);
  for (const path of ROOT_PLUGIN_FILES) {
    if (!expectedPaths.includes(path)) {
      throw new Error(`Manual archive is missing ${path}`);
    }
  }
  if (
    !expectedPaths.includes(`${PDF_ASSET_BUILD.assetDirectory}/${PDF_ASSET_BUILD.manifestFile}`)
  ) {
    throw new Error("Manual archive is missing the PDF asset manifest");
  }
  for (const path of expectedPaths) {
    assertSafeArchivePath(path);
    if (
      path.includes("node_modules") ||
      path.includes("cache") ||
      path.includes("key") ||
      path.includes("credential") ||
      path.includes("account") ||
      path.includes("@napi-rs") ||
      path.includes("canvas") ||
      path.includes("cmaps") ||
      path.includes("image_decoders") ||
      path.includes("wasm") ||
      (!expectedRootFiles.has(path) && !path.startsWith(`${PDF_ASSET_BUILD.assetDirectory}/`))
    ) {
      throw new Error(`Manual archive contains an unrelated or sensitive path: ${path}`);
    }
  }
}

function assertArchiveManifest(manifest) {
  if (
    manifest?.archiveSchemaVersion !== ARCHIVE_SCHEMA_VERSION ||
    manifest?.distribution !== "manual-experimental" ||
    manifest?.routes?.standardUpdaterIncludesArchive !== false ||
    manifest?.routes?.manualCopyRequired !== true ||
    !Array.isArray(manifest.files) ||
    !manifest.pdf?.assetManifestSha256 ||
    !manifest.archive ||
    !Number.isInteger(manifest.archive.bytes) ||
    manifest.archive.bytes < 0 ||
    !/^[a-f0-9]{64}$/.test(manifest.archive.sha256)
  ) {
    throw new Error("Manual archive manifest is invalid");
  }
  assertExpectedArchiveFiles(manifest.files);
  const seen = new Set();
  for (const entry of manifest.files) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      seen.has(entry.path) ||
      !Number.isInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error("Manual archive manifest contains an invalid file entry");
    }
    seen.add(entry.path);
  }
}

function assertSafeArchiveEntries(entries) {
  const seen = new Set();
  for (const entry of entries) {
    assertSafeArchivePath(entry.replace(/\/$/, ""));
    if (seen.has(entry)) {
      throw new Error(`Manual archive contains a duplicate path: ${entry}`);
    }
    seen.add(entry);
  }
}

function assertSafeArchivePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.startsWith("\\") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe manual archive path: ${path}`);
  }
}

function assertSamePaths(actual, expected) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  if (
    actualSorted.length !== expectedSorted.length ||
    actualSorted.some((path, index) => path !== expectedSorted[index])
  ) {
    throw new Error("Manual archive file list does not match its manifest");
  }
}

function resolveRequiredPath(value, description) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`A ${description} path is required`);
  }
  return resolve(value);
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function readJson(path, description) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Could not read ${description}: ${path}`);
  }
}

function parseCliArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const name = argument.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    values[name] = value;
    index += 1;
  }
  return values;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const archiveManifest = await buildPdfManualArchive({
      mainArtifactReceiptPath: args.receipt,
      outputPath: args.output,
      pdfAssetRoot: args["pdf-asset-root"],
      pluginArtifactRoot: args["artifact-root"],
    });
    process.stdout.write(`${JSON.stringify(archiveManifest, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Manual PDF archive failed"}\n`
    );
    process.exitCode = 1;
  }
}
