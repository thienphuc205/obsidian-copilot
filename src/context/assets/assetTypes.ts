import type { TFile } from "obsidian";

/** Maximum byte length accepted by the local raster-image foundation. */
export const MAX_LOCAL_IMAGE_BYTES = 3 * 1024 * 1024;

export const LOCAL_IMAGE_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
] as const;

export type LocalImageMediaType = (typeof LOCAL_IMAGE_MEDIA_TYPES)[number];

export type LocalImageExtension = "jpg" | "png" | "gif" | "webp" | "bmp";

export type LocalImageValidationFailure =
  | "too-large"
  | "unsupported"
  | "mismatched"
  | "invalid-bytes"
  | "digest-unavailable";

/** Stable source identity carried by local document and image adapters. */
export interface LocalSourceRef {
  vaultId: string;
  vaultPath: string;
  sourceNotePath?: string;
  kind: "image" | "pdf";
  mediaType: string;
  byteLength: number;
  contentDigest: string;
}

/** Validated metadata for one raster image payload. */
export interface LocalImageInspection {
  mediaType: LocalImageMediaType;
  extension: LocalImageExtension;
  byteLength: number;
  contentDigest: string;
}

export type LocalImageRejectionReason =
  | "not-found"
  | "external"
  | "unsupported"
  | "too-large"
  | "invalid-bytes"
  | "out-of-scope";

export type LocalImageResolution =
  | {
      status: "resolved";
      source: LocalSourceRef;
      bytes: ArrayBuffer;
      mimeType: LocalImageMediaType;
    }
  | {
      status: "rejected";
      reason: LocalImageRejectionReason;
      reference: string;
    };

/**
 * Reader boundary used by the local image resolver.
 *
 * Link resolution and binary access stay in the host adapter so the leaf does
 * not select an operating-system path or import an Obsidian singleton.
 */
export interface LocalImageReader {
  resolveLink(reference: string, sourceNotePath?: string): TFile | null;
  readBinary(file: TFile): Promise<ArrayBuffer>;
  getVaultId(): string;
  /** Host-owned authorization after link resolution and before bytes are read. */
  authorizeResolvedFile(file: TFile): boolean | Promise<boolean>;
}
