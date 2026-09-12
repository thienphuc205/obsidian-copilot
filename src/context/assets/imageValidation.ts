import {
  MAX_LOCAL_IMAGE_BYTES,
  type LocalImageExtension,
  type LocalImageInspection,
  type LocalImageMediaType,
  type LocalImageValidationFailure,
} from "@/context/assets/assetTypes";

interface ImageSignature {
  mediaType: LocalImageMediaType;
  extension: LocalImageExtension;
  matches(bytes: Uint8Array): boolean;
}

const IMAGE_SIGNATURES: readonly ImageSignature[] = [
  {
    mediaType: "image/png",
    extension: "png",
    matches: (bytes) =>
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a,
  },
  {
    mediaType: "image/jpeg",
    extension: "jpg",
    matches: (bytes) =>
      bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  {
    mediaType: "image/gif",
    extension: "gif",
    matches: (bytes) =>
      bytes.length >= 6 &&
      (readAscii(bytes, 0, 6) === "GIF87a" || readAscii(bytes, 0, 6) === "GIF89a"),
  },
  {
    mediaType: "image/webp",
    extension: "webp",
    matches: (bytes) =>
      bytes.length >= 12 && readAscii(bytes, 0, 4) === "RIFF" && readAscii(bytes, 8, 4) === "WEBP",
  },
  {
    mediaType: "image/bmp",
    extension: "bmp",
    matches: (bytes) => bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d,
  },
];

const MEDIA_TYPE_ALIASES: Readonly<Record<string, LocalImageMediaType>> = {
  "image/bmp": "image/bmp",
  "image/gif": "image/gif",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
};

const FAILURE_MESSAGES: Readonly<Record<LocalImageValidationFailure, string>> = {
  "digest-unavailable": "Image digest is unavailable",
  "invalid-bytes": "Image bytes are invalid",
  mismatched: "Image media type does not match its bytes",
  unsupported: "Image format is unsupported",
  "too-large": "Image is too large",
};

/** Typed, bounded failure from local raster validation. */
export class LocalImageValidationError extends Error {
  constructor(readonly reason: LocalImageValidationFailure) {
    super(FAILURE_MESSAGES[reason]);
    this.name = "LocalImageValidationError";
  }
}

/**
 * Validates a local raster payload and returns canonical metadata for storage.
 *
 * @param bytes Exact image bytes read from the approved local source.
 * @param declaredMediaType Optional MIME declaration from the source file.
 * @returns Canonical raster type, extension, size, and SHA-256 digest.
 */
export async function inspectLocalImage(
  bytes: ArrayBuffer,
  declaredMediaType?: string
): Promise<LocalImageInspection> {
  if (!(bytes instanceof ArrayBuffer)) {
    throw new LocalImageValidationError("invalid-bytes");
  }

  if (bytes.byteLength > MAX_LOCAL_IMAGE_BYTES) {
    throw new LocalImageValidationError("too-large");
  }

  const view = new Uint8Array(bytes);
  const signature = IMAGE_SIGNATURES.find((candidate) => candidate.matches(view));
  if (!signature) {
    throw new LocalImageValidationError("unsupported");
  }

  if (declaredMediaType !== undefined) {
    const declared = normalizeMediaType(declaredMediaType);
    if (!declared) {
      throw new LocalImageValidationError("unsupported");
    }
    if (declared !== signature.mediaType) {
      throw new LocalImageValidationError("mismatched");
    }
  }

  return {
    mediaType: signature.mediaType,
    extension: signature.extension,
    byteLength: bytes.byteLength,
    contentDigest: await digestBytes(bytes),
  };
}

function normalizeMediaType(value: string): LocalImageMediaType | null {
  if (typeof value !== "string") {
    return null;
  }
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return MEDIA_TYPE_ALIASES[mediaType] ?? null;
}

async function digestBytes(bytes: ArrayBuffer): Promise<string> {
  const subtle = window.crypto?.subtle;
  if (!subtle) {
    throw new LocalImageValidationError("digest-unavailable");
  }

  try {
    const digest = await subtle.digest("SHA-256", bytes.slice(0));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      ""
    );
  } catch {
    throw new LocalImageValidationError("digest-unavailable");
  }
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = offset; index < offset + length; index++) {
    value += String.fromCharCode(bytes[index] ?? 0);
  }
  return value;
}
