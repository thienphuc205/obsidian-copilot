import type { TFile } from "obsidian";

import {
  MAX_LOCAL_IMAGE_BYTES,
  type LocalImageMediaType,
  type LocalImageReader,
  type LocalImageRejectionReason,
  type LocalImageResolution,
} from "@/context/assets/assetTypes";
import { LocalImageValidationError, inspectLocalImage } from "@/context/assets/imageValidation";

const MAX_IMAGE_REFERENCE_LENGTH = 4096;
const LOCAL_URI_SCHEMES = new Set(["app", "attachment"]);

/**
 * Resolves one parsed image destination through an injected vault boundary.
 *
 * @param reference Parsed Markdown or wiki image destination.
 * @param sourceNotePath Containing note path used for relative resolution.
 * @param reader Host-owned link and binary reader.
 * @returns A validated local image or a bounded policy/validation rejection.
 */
export async function resolveEmbeddedLocalImage(
  reference: string,
  sourceNotePath: string | undefined,
  reader: LocalImageReader
): Promise<LocalImageResolution> {
  const displayReference = boundReference(reference);
  const prepared = prepareReference(reference, sourceNotePath);
  if ("reason" in prepared) {
    return rejected(prepared.reason, displayReference);
  }

  let file: TFile | null;
  try {
    file = reader.resolveLink(prepared.linkReference, prepared.sourceNotePath);
  } catch {
    return rejected("not-found", displayReference);
  }

  if (!file || !isVaultRelativePath(file.path)) {
    return rejected(file ? "out-of-scope" : "not-found", displayReference);
  }

  const normalizedVaultPath = normalizeVaultPath(file.path);
  if (!normalizedVaultPath) {
    return rejected("out-of-scope", displayReference);
  }

  const declaredMediaType = mediaTypeForExtension(file.extension || extensionFromPath(file.path));
  if (!declaredMediaType) {
    return rejected("unsupported", displayReference);
  }

  if (hasKnownOversize(file)) {
    return rejected("too-large", displayReference);
  }

  let vaultId: string;
  try {
    vaultId = reader.getVaultId();
  } catch {
    return rejected("out-of-scope", displayReference);
  }
  if (!isValidVaultId(vaultId)) {
    return rejected("out-of-scope", displayReference);
  }

  if (typeof reader.authorizeResolvedFile !== "function") {
    return rejected("out-of-scope", displayReference);
  }
  try {
    if (!(await reader.authorizeResolvedFile(file))) {
      return rejected("out-of-scope", displayReference);
    }
  } catch {
    return rejected("out-of-scope", displayReference);
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await reader.readBinary(file);
  } catch {
    return rejected("not-found", displayReference);
  }

  if (!(bytes instanceof ArrayBuffer)) {
    return rejected("invalid-bytes", displayReference);
  }

  let inspection;
  try {
    inspection = await inspectLocalImage(bytes, declaredMediaType);
  } catch (error) {
    return rejected(mapValidationFailure(error), displayReference);
  }

  return {
    status: "resolved",
    source: {
      vaultId,
      vaultPath: normalizedVaultPath,
      ...(prepared.sourceNotePath ? { sourceNotePath: prepared.sourceNotePath } : {}),
      kind: "image",
      mediaType: inspection.mediaType,
      byteLength: inspection.byteLength,
      contentDigest: inspection.contentDigest,
    },
    bytes,
    mimeType: inspection.mediaType,
  };
}

interface PreparedReference {
  linkReference: string;
  sourceNotePath?: string;
}

interface PreparedReferenceRejection {
  reason: LocalImageRejectionReason;
}

function prepareReference(
  reference: string,
  sourceNotePath: string | undefined
): PreparedReference | PreparedReferenceRejection {
  if (typeof reference !== "string") {
    return { reason: "out-of-scope" };
  }

  const trimmedReference = reference.trim();
  if (!isBoundedText(trimmedReference) || hasControlCharacter(trimmedReference)) {
    return { reason: "out-of-scope" };
  }

  const normalizedSourceNotePath = sourceNotePath
    ? (normalizeVaultPath(sourceNotePath) ?? undefined)
    : undefined;
  if (sourceNotePath && !normalizedSourceNotePath) {
    return { reason: "out-of-scope" };
  }

  const scheme = getScheme(trimmedReference);
  if (isAbsolutePath(trimmedReference)) {
    return { reason: "out-of-scope" };
  }
  if (scheme && !LOCAL_URI_SCHEMES.has(scheme)) {
    return { reason: "external" };
  }

  if (scheme && LOCAL_URI_SCHEMES.has(scheme)) {
    return {
      linkReference: trimmedReference,
      ...(normalizedSourceNotePath ? { sourceNotePath: normalizedSourceNotePath } : {}),
    };
  }

  const decodedReference = decodeLocalReference(trimmedReference);
  if (!decodedReference || hasControlCharacter(decodedReference)) {
    return { reason: "out-of-scope" };
  }
  const localReference = stripLocalFragmentAndQuery(decodedReference);
  if (!localReference || !resolveVaultPath(normalizedSourceNotePath, localReference)) {
    return { reason: "out-of-scope" };
  }

  return {
    linkReference: localReference,
    ...(normalizedSourceNotePath ? { sourceNotePath: normalizedSourceNotePath } : {}),
  };
}

function isBoundedText(value: string): boolean {
  return value.length > 0 && value.length <= MAX_IMAGE_REFERENCE_LENGTH;
}

function boundReference(reference: string): string {
  if (typeof reference !== "string") {
    return "";
  }
  return reference.length <= MAX_IMAGE_REFERENCE_LENGTH
    ? reference
    : reference.slice(0, MAX_IMAGE_REFERENCE_LENGTH);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function getScheme(value: string): string | null {
  const match = /^([a-z][a-z\d+.-]*):/iu.exec(value);
  return match?.[1]?.toLowerCase() ?? null;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^\\\\/u.test(value) || /^[a-z]:[\\/]/iu.test(value);
}

function decodeLocalReference(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function stripLocalFragmentAndQuery(value: string): string {
  const hashIndex = value.indexOf("#");
  const queryIndex = value.indexOf("?");
  const cutIndex = [hashIndex, queryIndex]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  return value.slice(0, cutIndex ?? value.length).trim();
}

function resolveVaultPath(sourceNotePath: string | undefined, reference: string): string | null {
  const baseSegments = sourceNotePath?.split("/").slice(0, -1) ?? [];
  const stack = baseSegments.filter(Boolean);

  for (const segment of reference.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (stack.length === 0) {
        return null;
      }
      stack.pop();
      continue;
    }
    stack.push(segment);
  }

  return stack.join("/") || null;
}

function isVaultRelativePath(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IMAGE_REFERENCE_LENGTH &&
    !isAbsolutePath(value) &&
    !hasControlCharacter(value)
  );
}

function normalizeVaultPath(value: string): string | null {
  if (!isVaultRelativePath(value)) {
    return null;
  }
  return resolveVaultPath(undefined, value);
}

function extensionFromPath(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  const basename = path.slice(separatorIndex + 1);
  const dotIndex = basename.lastIndexOf(".");
  return dotIndex > 0 ? basename.slice(dotIndex + 1) : "";
}

function mediaTypeForExtension(extension: string): LocalImageMediaType | null {
  switch (extension.trim().toLowerCase()) {
    case "bmp":
      return "image/bmp";
    case "gif":
      return "image/gif";
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

function hasKnownOversize(file: TFile): boolean {
  const size = file.stat?.size;
  return typeof size === "number" && Number.isFinite(size) && size > MAX_LOCAL_IMAGE_BYTES;
}

function isValidVaultId(vaultId: string): boolean {
  return (
    typeof vaultId === "string" &&
    vaultId.trim().length > 0 &&
    vaultId.length <= 256 &&
    !hasControlCharacter(vaultId)
  );
}

function mapValidationFailure(error: unknown): LocalImageRejectionReason {
  if (!(error instanceof LocalImageValidationError)) {
    return "invalid-bytes";
  }
  switch (error.reason) {
    case "too-large":
      return "too-large";
    case "unsupported":
      return "unsupported";
    default:
      return "invalid-bytes";
  }
}

function rejected(reason: LocalImageRejectionReason, reference: string): LocalImageResolution {
  return { status: "rejected", reason, reference };
}
