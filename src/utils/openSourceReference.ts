import {
  resolveSourceInspectorTarget,
  type SourceReference,
  type VaultSourceInspectorTarget,
} from "@/context/sourceReferences";
import { logError } from "@/logger";
import { openFileInWorkspace } from "@/utils";
import { App, Notice, TFile } from "obsidian";

/**
 * Open a citation target after validating its kind and, for vault sources,
 * resolving the path through the current vault inventory.
 *
 * Returns false when the source is malformed or no longer available. It never
 * sends an untrusted vault path to the OS or lets `openLinkText` fabricate a
 * missing note outside the current vault.
 */
export async function openSourceReference(app: App, source: SourceReference): Promise<boolean> {
  const target = resolveSourceInspectorTarget(source);
  if (!target) {
    new Notice("This source is unavailable or has an invalid reference.");
    return false;
  }

  if (target.kind === "web") {
    const opened = window.open(target.url, "_blank", "noopener,noreferrer");
    if (!opened) {
      new Notice("The source could not be opened in the browser.");
      return false;
    }
    return true;
  }

  const file = app.vault.getAbstractFileByPath(target.path);
  if (!(file instanceof TFile)) {
    new Notice("This source is no longer available in the current vault.");
    return false;
  }

  try {
    if (target.page !== undefined) {
      await app.workspace.openLinkText(buildVaultLinkTarget(target), "", false);
      return true;
    }

    if (target.line !== undefined) {
      const leaf = app.workspace.getLeaf("tab");
      await leaf.openFile(file);
      const view = leaf.view as unknown as {
        file?: { path?: string };
        editor?: { setCursor: (position: { line: number; ch: number }) => void };
      } | null;
      if (view?.file?.path === target.path && typeof view.editor?.setCursor === "function") {
        view.editor.setCursor({ line: target.line - 1, ch: 0 });
      }
      return true;
    }

    if (target.anchor) {
      await app.workspace.openLinkText(buildVaultLinkTarget(target), "", false);
      return true;
    }

    await openFileInWorkspace(app, file);
    return true;
  } catch (error) {
    logError("Failed to open source reference:", error);
    new Notice("The source could not be opened.");
    return false;
  }
}

function buildVaultLinkTarget(target: VaultSourceInspectorTarget): string {
  if (target.page !== undefined) {
    return `${target.path}#page=${target.page}`;
  }
  return `${target.path}${target.anchor ?? ""}`;
}
