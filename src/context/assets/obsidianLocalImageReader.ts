import { FileSystemAdapter, type App, type TFile, type Vault } from "obsidian";

import { requireNodeModule, isDesktopRuntime } from "@/utils/desktopRuntime";
import type { LocalImageReader } from "@/context/assets/assetTypes";

const MAX_REFERENCE_LENGTH = 4096;
const LOCAL_URI_SCHEMES = new Set(["app", "attachment"]);

/** Options that bind the reader to one explicit Obsidian vault and scope. */
export interface ObsidianLocalImageReaderOptions {
  /** Obsidian application owning the metadata cache and vault. */
  readonly app: App;
  /** Vault whose files may be resolved and read. */
  readonly vault: Vault;
  /** Stable caller-supplied identity retained in resolved source metadata. */
  readonly vaultId: string;
  /** Optional vault-relative directory boundary; omitted means the whole vault. */
  readonly scopePath?: string;
}

/**
 * Creates an unwired local image reader for one explicit Obsidian vault.
 *
 * The reader resolves links through Obsidian, but authorizes the returned file
 * with canonical desktop paths immediately before every binary read. Node
 * modules are loaded only inside that desktop-only authorization path; mobile
 * and malformed hosts fail closed without a cloud or filesystem fallback.
 *
 * @param options Explicit application, vault, identity, and optional scope.
 * @returns A reader that satisfies the shared local-image boundary.
 */
export function createObsidianLocalImageReader(
  options: ObsidianLocalImageReaderOptions
): LocalImageReader {
  const { app, vault, vaultId } = options;
  const scopePath = normalizeVaultRelativePath(options.scopePath ?? "");
  const appOwnsVault = app.vault === vault;

  const resolveLink = (reference: string, sourceNotePath?: string): TFile | null => {
    if (!appOwnsVault || scopePath === null) {
      return null;
    }

    const prepared = prepareLinkReference(reference, sourceNotePath);
    if (!prepared) {
      return null;
    }

    try {
      return app.metadataCache.getFirstLinkpathDest(
        prepared.reference,
        prepared.sourceNotePath ?? ""
      );
    } catch {
      return null;
    }
  };

  const authorizeResolvedFile = (file: TFile): boolean => {
    if (!appOwnsVault || scopePath === null || !isValidVaultId(vaultId)) {
      return false;
    }
    if (!isDesktopRuntime()) {
      return false;
    }

    const vaultBase = getVaultBase(vault);
    if (!vaultBase) {
      return false;
    }

    try {
      const fs = requireNodeModule<typeof import("node:fs")>("fs");
      const nodePath = requireNodeModule<typeof import("node:path")>("path");
      const canonicalBase = fs.realpathSync(vaultBase);
      const targetPath = normalizeVaultRelativePath(file.path);
      if (!targetPath) {
        return false;
      }

      const lexicalTarget = nodePath.resolve(vaultBase, targetPath);
      if (!isContained(nodePath, vaultBase, lexicalTarget)) {
        return false;
      }

      const canonicalScope = scopePath
        ? fs.realpathSync(nodePath.resolve(vaultBase, scopePath))
        : canonicalBase;
      if (!isContained(nodePath, canonicalBase, canonicalScope, true)) {
        return false;
      }

      const canonicalTarget = fs.realpathSync(lexicalTarget);
      return (
        isContained(nodePath, canonicalBase, canonicalTarget) &&
        isContained(nodePath, canonicalScope, canonicalTarget, true)
      );
    } catch {
      return false;
    }
  };

  return {
    resolveLink,
    authorizeResolvedFile,
    async readBinary(file) {
      if (!authorizeResolvedFile(file)) {
        throw new Error("Local image read denied");
      }
      try {
        return await vault.readBinary(file);
      } catch {
        throw new Error("Local image read failed");
      }
    },
    getVaultId: () => vaultId,
  };
}

interface PreparedLinkReference {
  reference: string;
  sourceNotePath?: string;
}

function prepareLinkReference(
  reference: string,
  sourceNotePath: string | undefined
): PreparedLinkReference | null {
  if (typeof reference !== "string") {
    return null;
  }

  const trimmedReference = reference.trim();
  if (!isBoundedText(trimmedReference) || hasControlCharacter(trimmedReference)) {
    return null;
  }

  const normalizedSourceNotePath = sourceNotePath
    ? (normalizeVaultRelativePath(sourceNotePath) ?? undefined)
    : undefined;
  if (sourceNotePath && normalizedSourceNotePath === undefined) {
    return null;
  }

  const scheme = getScheme(trimmedReference);
  if (isAbsolutePath(trimmedReference)) {
    return null;
  }
  if (scheme && !LOCAL_URI_SCHEMES.has(scheme)) {
    return null;
  }
  if (scheme && LOCAL_URI_SCHEMES.has(scheme)) {
    return {
      reference: trimmedReference,
      ...(normalizedSourceNotePath ? { sourceNotePath: normalizedSourceNotePath } : {}),
    };
  }

  const decodedReference = decodeLocalReference(trimmedReference);
  if (!decodedReference || hasControlCharacter(decodedReference)) {
    return null;
  }
  const localReference = stripLocalFragmentAndQuery(decodedReference);
  if (!localReference || !resolveVaultPath(normalizedSourceNotePath, localReference)) {
    return null;
  }

  return {
    reference: localReference,
    ...(normalizedSourceNotePath ? { sourceNotePath: normalizedSourceNotePath } : {}),
  };
}

function getVaultBase(vault: Vault): string | null {
  try {
    const adapter = vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      return null;
    }
    const basePath = adapter.getBasePath();
    return typeof basePath === "string" && isAbsolutePath(basePath) ? basePath : null;
  } catch {
    return null;
  }
}

function isContained(
  nodePath: typeof import("node:path"),
  root: string,
  target: string,
  allowEqual = false
): boolean {
  const relative = nodePath.relative(root, target);
  if (relative === "") {
    return allowEqual;
  }
  return (
    relative !== ".." && !relative.startsWith(".." + nodePath.sep) && !nodePath.isAbsolute(relative)
  );
}

function normalizeVaultRelativePath(value: string): string | null {
  if (
    typeof value !== "string" ||
    value.length > MAX_REFERENCE_LENGTH ||
    isAbsolutePath(value) ||
    hasControlCharacter(value)
  ) {
    return null;
  }

  const stack: string[] = [];
  for (const segment of value.replaceAll("\\", "/").split("/")) {
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
  return stack.join("/");
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

function isBoundedText(value: string): boolean {
  return value.length > 0 && value.length <= MAX_REFERENCE_LENGTH;
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

function isValidVaultId(vaultId: string): boolean {
  return (
    typeof vaultId === "string" &&
    vaultId.trim().length > 0 &&
    vaultId.length <= 256 &&
    !hasControlCharacter(vaultId)
  );
}
