import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildPdfAssets, verifyPdfAssetPackage } from "./build-pdf-assets.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("buildPdfAssets emits and verifies the exact local worker package", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "copilot-pdf-assets-"));

  try {
    const manifest = await buildPdfAssets({ outputRoot, repositoryRoot });
    const paths = manifest.files.map(({ path }) => path);

    assert.equal(manifest.package.name, "pdfjs-dist");
    assert.equal(manifest.package.version, "6.3.289");
    assert.equal(manifest.package.license, "Apache-2.0");
    assert.deepEqual(manifest.versionPair, {
      api: "6.3.289",
      worker: "6.3.289",
    });
    assert.equal(manifest.runtime.workerRequired, true);
    assert.equal(manifest.runtime.fallback, "none");
    assert.equal(manifest.network.documentDownload, false);
    assert.equal(manifest.network.runtimeAssetDownload, false);
    assert.ok(paths.includes("pdf-parser.mjs"));
    assert.ok(paths.includes("pdf.worker.mjs"));
    assert.ok(paths.includes("standard_fonts/FoxitDingbats.pfb"));
    assert.ok(paths.includes("licenses/pdfjs/LICENSE"));
    assert.ok(paths.includes("licenses/standard_fonts/LICENSE_FOXIT"));
    assert.ok(paths.includes("licenses/standard_fonts/LICENSE_LIBERATION"));
    assert.ok(paths.every((path) => !/(^|\/)(cmaps|wasm|image_decoders)(\/|$)/.test(path)));
    assert.ok(paths.every((path) => !path.includes("@napi-rs/canvas")));

    await assert.doesNotReject(() =>
      verifyPdfAssetPackage({ outputRoot, expectedVersion: "6.3.289" })
    );

    const unexpectedPath = join(outputRoot, "unexpected.txt");
    await writeFile(unexpectedPath, "not a PDF asset");
    await assert.rejects(
      () => buildPdfAssets({ outputRoot, repositoryRoot }),
      /PDF asset directory contains unexpected entries/
    );
    await rm(unexpectedPath);

    const manifestPath = join(outputRoot, "asset-manifest.json");
    const originalManifest = await readFile(manifestPath, "utf8");
    const traversalManifest = JSON.parse(originalManifest);
    traversalManifest.files[0].path = `..\\${traversalManifest.files[0].path}`;
    await writeFile(manifestPath, JSON.stringify(traversalManifest));
    await assert.rejects(
      () => verifyPdfAssetPackage({ outputRoot }),
      /PDF asset manifest contains an invalid file path/
    );
    await writeFile(manifestPath, originalManifest);

    const workerPath = join(outputRoot, "pdf.worker.mjs");
    const originalWorker = await readFile(workerPath);
    await writeFile(workerPath, Buffer.concat([originalWorker, Buffer.from("\ncorrupt")]));
    await assert.rejects(
      () => verifyPdfAssetPackage({ outputRoot }),
      /PDF asset checksum mismatch: pdf\.worker\.mjs/
    );
    await writeFile(workerPath, originalWorker);

    await rm(workerPath);
    await assert.rejects(() => verifyPdfAssetPackage({ outputRoot }), /ENOENT|no such file/i);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
