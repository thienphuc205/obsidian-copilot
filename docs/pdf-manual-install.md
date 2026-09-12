# Experimental local PDF package

This manual archive delivers an experimental local PDF.js parser, its local
assets, and the host adapter that activates them lazily on desktop. A complete
archive enables page-aware text extraction for PDF files passed through
Copilot's existing file-parser/chat-context path. Native Obsidian execution
remains unverified, and the extra assets are not part of Copilot's normal
Obsidian update route yet.

The current parser is text-oriented. OCR for scanned pages, table/figure
structure, captions, and richer multimodal PDF output remain later milestones;
the local package does not claim those capabilities yet.

## Why this is a separate package

Obsidian's normal plugin update and this repository's release workflow deliver
the three plugin files `main.js`, `manifest.json`, and `styles.css`. They do
not unpack a `pdfjs/` directory. Uploading a PDF zip beside those files does
not make Obsidian install or update the directory, so the normal distribution
must continue to treat the PDF reader as unavailable until a supported delivery
route carries its extra assets.

The full manual archive contains the three normal plugin files plus the
version-paired `pdfjs/` API, worker, standard fonts, license notices, and asset
manifest. The bundled host adapter probes for that complete tree only when a
PDF is parsed. A successful archive build requires a successful-build receipt
for the exact `main.js`, `manifest.json`, and `styles.css` inputs from an isolated snapshot built with
the checked-in lockfile. The snapshot may include intentional uncommitted
source changes; the receipt does not require a Git-clean upstream checkout.
Failed builds or inputs that no longer match the receipt are rejected.

## Setup and manual rollback

Use this only with an archive from a reviewed build. Close Obsidian, keep a
backup of the current Copilot plugin folder, and extract the archive contents
as one complete set into that plugin folder. Preserve the `pdfjs/` directory;
copying only the three root files omits those experimental assets. Reopen
Obsidian and enable the plugin only after the extracted set is complete.
On desktop, the first PDF parse probes the package lazily. If `pdfjs/` is
missing, the normal Miyo/Plus route remains available. If a present package is
incomplete, malformed, or cannot load, Copilot fails that local parse closed instead of
silently uploading the PDF to another backend.

The normal updater does not manage this experimental directory. To roll back,
disable the experimental copy and restore the backed-up plugin folder or a
standard three-file installation. Do not treat a standard update as proof that
old experimental PDF assets were removed; replace the complete plugin folder
from a known-good backup when the PDF package must be removed.

## Privacy and availability

When the complete package is present, the parser receives PDF bytes from the
vault, uses the version-paired API, worker, and fonts from the local plugin
package, and runs before the legacy PDF cache and Miyo/Plus routes. The tested
package has no CDN or runtime document-download fallback. An invalid package
fails closed; a package that is absent leaves the existing route unchanged.
This is a delivery and parsing property, not a full agent sandbox: a later
agent turn, remote model, or other shell, filesystem, or MCP tool may still send
context or extracted text outside the device when that route is selected. Do
not put sensitive content in an agent-generated query merely because local
parsing is enabled.

The archive does not require a Copilot Plus license. Agent backends, remote
models, and their own account or billing requirements remain separate. No
active Firecrawl validation is implied by this package, and no claim is made
that the PDF reader is available on mobile or through the standard updater.

Until the extra-asset delivery route is reviewed and supported, PDF remains
disabled in the standard distribution. This manual archive is local test and
preview evidence, not a published release artifact.
