import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPdfManualArchive, verifyPdfManualArchive } from "./build-pdf-manual-archive.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("builds, unpacks, hashes, and reproducibly verifies a complete PDF manual archive", async () => {
  const testRoot = await mkdtemp(join(repositoryRoot, ".pdf-manual-archive-test-"));
  try {
    const artifactRoot = join(testRoot, "main-artifact");
    await mkdir(artifactRoot, { recursive: true });
    await writeFixtureArtifact(artifactRoot);
    const receiptPath = join(testRoot, "main-artifact.receipt.json");
    await writeReceipt(receiptPath, artifactRoot);

    const firstArchivePath = join(testRoot, "copilot-pdf-manual-1.zip");
    const firstManifest = await buildPdfManualArchive({
      mainArtifactReceiptPath: receiptPath,
      outputPath: firstArchivePath,
      pluginArtifactRoot: artifactRoot,
      pdfAssetRoot: join(repositoryRoot, "pdfjs"),
    });
    await verifyPdfManualArchive({
      archivePath: firstArchivePath,
      manifestPath: `${firstArchivePath}.manifest.json`,
    });

    const secondArchivePath = join(testRoot, "copilot-pdf-manual-2.zip");
    const secondManifest = await buildPdfManualArchive({
      mainArtifactReceiptPath: receiptPath,
      outputPath: secondArchivePath,
      pluginArtifactRoot: artifactRoot,
      pdfAssetRoot: join(repositoryRoot, "pdfjs"),
    });

    assert.deepEqual(firstManifest.files, secondManifest.files);
    assert.equal(firstManifest.archive.sha256, secondManifest.archive.sha256);
    assert.equal(firstManifest.pdf.versionPair.api, "6.3.289");
    assert.equal(firstManifest.pdf.versionPair.worker, "6.3.289");
    assert.ok(firstManifest.files.some(({ path }) => path === "pdfjs/pdf.worker.mjs"));
    assert.ok(firstManifest.files.some(({ path }) => path === "pdfjs/asset-manifest.json"));
    assert.ok(firstManifest.files.every(({ path }) => !path.includes("@napi-rs/canvas")));
    assert.ok(firstManifest.files.every(({ path }) => !path.includes("node_modules")));
    assert.ok(firstManifest.files.every(({ path }) => !path.includes("cache")));
    assert.ok(firstManifest.files.every(({ path }) => !path.includes("key")));
  } finally {
    await rm(testRoot, { force: true, recursive: true });
  }
});

test("refuses a failed or stale main artifact receipt before packaging", async () => {
  const testRoot = await mkdtemp(join(repositoryRoot, ".pdf-manual-archive-receipt-test-"));
  try {
    const artifactRoot = join(testRoot, "main-artifact");
    await mkdir(artifactRoot, { recursive: true });
    await writeFixtureArtifact(artifactRoot);
    const receiptPath = join(testRoot, "main-artifact.receipt.json");
    await writeReceipt(receiptPath, artifactRoot, { status: "failed" });

    await assert.rejects(
      buildPdfManualArchive({
        mainArtifactReceiptPath: receiptPath,
        outputPath: join(testRoot, "failed.zip"),
        pluginArtifactRoot: artifactRoot,
        pdfAssetRoot: join(repositoryRoot, "pdfjs"),
      }),
      /successful clean main-artifact receipt/
    );

    await writeReceipt(receiptPath, artifactRoot);
    await writeFile(join(artifactRoot, "main.js"), "changed after receipt\n", "utf8");
    await assert.rejects(
      buildPdfManualArchive({
        mainArtifactReceiptPath: receiptPath,
        outputPath: join(testRoot, "stale.zip"),
        pluginArtifactRoot: artifactRoot,
        pdfAssetRoot: join(repositoryRoot, "pdfjs"),
      }),
      /Main artifact receipt checksum mismatch: main\.js/
    );
  } finally {
    await rm(testRoot, { force: true, recursive: true });
  }
});

test("rejects archive path traversal before unpacking", async () => {
  const testRoot = await mkdtemp(join(repositoryRoot, ".pdf-manual-archive-path-test-"));
  try {
    const artifactRoot = join(testRoot, "main-artifact");
    await mkdir(artifactRoot, { recursive: true });
    await writeFixtureArtifact(artifactRoot);
    const receiptPath = join(testRoot, "main-artifact.receipt.json");
    await writeReceipt(receiptPath, artifactRoot);
    const validArchivePath = join(testRoot, "valid.zip");
    const validManifest = await buildPdfManualArchive({
      mainArtifactReceiptPath: receiptPath,
      outputPath: validArchivePath,
      pluginArtifactRoot: artifactRoot,
      pdfAssetRoot: join(repositoryRoot, "pdfjs"),
    });

    const maliciousRoot = join(testRoot, "malicious");
    await mkdir(maliciousRoot, { recursive: true });
    await writeFile(join(testRoot, "escaped.txt"), "outside\n", "utf8");
    const maliciousArchivePath = join(testRoot, "malicious.zip");
    await execFile("zip", ["-X", "-q", maliciousArchivePath, "../escaped.txt"], {
      cwd: maliciousRoot,
    });

    await assert.rejects(
      verifyPdfManualArchive({
        archivePath: maliciousArchivePath,
        expectedManifest: validManifest,
      }),
      /Unsafe manual archive path/
    );
  } finally {
    await rm(testRoot, { force: true, recursive: true });
  }
});

async function writeFixtureArtifact(artifactRoot) {
  await writeFile(join(artifactRoot, "main.js"), "fixture main artifact\n", "utf8");
  await writeFile(
    join(artifactRoot, "manifest.json"),
    `${JSON.stringify({ id: "copilot", version: "4.0.7" })}\n`,
    "utf8"
  );
  await writeFile(join(artifactRoot, "styles.css"), "fixture styles\n", "utf8");
}

async function writeReceipt(receiptPath, artifactRoot, overrides = {}) {
  const files = {};
  for (const path of ["main.js", "manifest.json", "styles.css"]) {
    const contents = await readFile(join(artifactRoot, path));
    files[path] = {
      bytes: contents.byteLength,
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
  }
  await writeFile(
    receiptPath,
    `${JSON.stringify(
      {
        artifactKind: "obsidian-plugin-main",
        artifactRoot: resolve(artifactRoot),
        files,
        schemaVersion: 1,
        source: { clean: true, revision: "fixture" },
        status: "success",
        ...overrides,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}
