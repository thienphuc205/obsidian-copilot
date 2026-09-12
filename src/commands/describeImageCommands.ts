import type { MessageContent } from "@langchain/core/messages";
import { HumanMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

import type { LocalImageReader } from "@/context/assets/assetTypes";
import { parseEmbeddedAssetReferences } from "@/context/assets/assetReferenceParser";
import { resolveEmbeddedLocalImage } from "@/context/assets/embeddedAssetResolver";
import { ATTACHMENT_MAX_BYTES } from "@/context/assets/attachmentStoreTypes";
import {
  createVaultImageDescriptionIO,
  IMAGE_DESCRIPTIONS_STORE_PATH,
} from "@/context/assets/imageDescriptionStore";
export { IMAGE_DESCRIPTIONS_STORE_PATH as IMAGE_DESCRIPTIONS_PATH };
import {
  ImageDescriptionStore,
  IMAGE_DESCRIPTION_MAX_LENGTH,
  type ImageDescriptionIO,
  type PutImageDescriptionInput,
} from "@/context/assets/imageDescriptionStore";
import { createObsidianLocalImageReader } from "@/context/assets/obsidianLocalImageReader";
import { arrayBufferToBase64 } from "@/utils/base64";
import type CopilotPlugin from "@/main";
import { LLM_TIMEOUT_MS } from "@/constants";
import { resolveLocalAwareTimeout } from "@/modelManagement";
import { logError, logWarn } from "@/logger";
import type { App, Command } from "obsidian";
import { withTimeout } from "@/utils";
import { Notice, TFile } from "obsidian";

export const DESCRIPTION_IMAGES_COMMAND_ID = "describe-active-note-images";
export const DESCRIPTION_IMAGES_COMMAND_NAME = "Describe active note images for search";

/** Hard per-run cap so one image-heavy note cannot run an unbounded model batch. */
const MAX_IMAGES_PER_RUN = 20;
/** Mirrors the store's model field bound so a long model name stays storable. */
const MAX_FAILURE_REASON_LENGTH = 200;
const OPEN_NOTE_NOTICE = "Open a note first.";
const NO_IMAGES_NOTICE = "No embedded images in this note.";
const FAILURE_NOTICE = "Failed to describe the note images.";

const IMAGE_DESCRIPTION_PROMPT =
  "Describe this image for a search index in under 60 words: screen/app type, " +
  "key UI, layout, text, colors. Text only.";

/** Seams so tests can pin the clock, model call, store, and image reader. */
export interface DescribeImageDependencies {
  /** Clock used for the stored updatedAt stamps; defaults to the system time. */
  readonly now?: () => Date;
  /**
   * Model adapter for one image. It receives the same `{ type: "image_url",
   * image_url: { url } }` content block the chat pipeline produces and
   * resolves to the raw model response. Defaults to the configured chat model.
   */
  readonly describeImage?: (content: unknown) => Promise<unknown>;
  /** Persistence seam for the description store; defaults to `vault.adapter`. */
  readonly io?: ImageDescriptionIO;
  /** Vault image reader seam; defaults to the shared Obsidian local-image reader. */
  readonly createReader?: () => LocalImageReader | Promise<LocalImageReader>;
  /** Overrides the per-run image cap; defaults to {@link MAX_IMAGES_PER_RUN}. */
  readonly maxImagesPerRun?: number;
  /**
   * Suppress every Notice (success, skip, and failure); failures are still
   * logged. Background callers such as the image auto-index queue use this so
   * vault-driven runs cannot stack Notices on transient model outages.
   */
  readonly quiet?: boolean;
}

/** Outcome of one {@link describeNoteImages} run over a single note. */
export type DescribeNoteImagesResult = "described" | "skipped" | "failed";

async function loadChatModel(): Promise<BaseChatModel> {
  try {
    // Dynamic import keeps module-load side effects out of synthetic tests
    // (mirroring safeGetChatModel in src/search/v3/TieredLexicalRetriever.ts).
    const mod = await import("@/LLMProviders/chatModelManager");
    return mod.default.getInstance().getChatModel();
  } catch (error) {
    throw new Error("No chat model available for image description", { cause: error });
  }
}

/**
 * Default describeImage seam: lazily build the configured chat model and ask
 * it for a search-index description of one image block. Propagates model
 * failures so the command can count them per image.
 */
async function defaultDescribeImage(content: unknown): Promise<unknown> {
  const model = await loadChatModel();
  const message = new HumanMessage({
    // The chat pipeline's multimodal shape (ImageProcessor output consumed in
    // chat) is a `content` array with the prompt text first, then one
    // `image_url` block per image. That shape predates LangChain v1's
    // ContentBlock union, so the array is cast through unknown to MessageContent.
    content: [
      { type: "text", text: IMAGE_DESCRIPTION_PROMPT },
      content,
    ] as unknown as MessageContent,
  });
  const response: unknown = await model.invoke([message]);
  return response;
}

/**
 * Encode one resolved image as the chat pipeline's `image_url` data-URL block,
 * call the injected model adapter, and bound the untrusted response before it
 * can reach the description store. Nullish and non-text-like responses must
 * not become junk such as the literal string "null" or "[object Object]".
 */
async function describeBoundedImage(
  describeImage: (content: unknown) => Promise<unknown>,
  mime: string,
  bytes: ArrayBuffer
): Promise<string> {
  const base64 = arrayBufferToBase64(bytes);
  // A hung local model must not block the command; self-hosted gets the long budget.
  const response = await withTimeout(
    () => describeImage({ type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } }),
    await resolveLocalAwareTimeout(LLM_TIMEOUT_MS),
    "Image description"
  );
  const textValue =
    typeof response === "string" ||
    (typeof response === "number" && Number.isFinite(response)) ||
    typeof response === "boolean"
      ? response
      : typeof response === "object" &&
          response !== null &&
          typeof (response as { text?: unknown }).text === "string"
        ? (response as { text: string }).text
        : null;
  const text = typeof textValue === "string" ? textValue.trim() : String(textValue ?? "").trim();
  if (text.length === 0) {
    throw new Error("Image describer returned no description");
  }
  return text.slice(0, IMAGE_DESCRIPTION_MAX_LENGTH);
}

async function createVaultImageReader(app: App): Promise<LocalImageReader> {
  const { KeychainService } = await import("@/services/keychainService");
  // Embedded images may live anywhere in the vault (attachment folders outside
  // the note's own directory), so the reader is not scoped to the note parent.
  return createObsidianLocalImageReader({
    app,
    vault: app.vault,
    vaultId: KeychainService.getInstance(app).getVaultId(),
  });
}

function getActiveMarkdownFile(app: App): TFile | null {
  const activeFile = app.workspace.getActiveFile();
  return activeFile && activeFile.extension?.toLowerCase() === "md" && activeFile.path
    ? activeFile
    : null;
}

function formatFailureReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= MAX_FAILURE_REASON_LENGTH ? text : text.slice(0, MAX_FAILURE_REASON_LENGTH);
}

/**
 * Run the describe-images flow for one note and report the outcome.
 *
 * The shared implementation behind {@link createDescribeImageCommand} and the
 * background image auto-index queue: it walks the note's embedded image
 * references, resolves each through the vault, and asks the configured chat
 * model for a bounded search description that is stored digest-keyed in
 * `.copilot/image-descriptions.json` for later multimodal retrieval. Every
 * image fails closed: one broken image never stops the run.
 *
 * @param plugin - Plugin instance that owns the current Obsidian application.
 * @param notePath - Vault path of the note to describe.
 * @param dependencies - Optional seams for synthetic tests; `quiet` also
 * suppresses every Notice so background runs stay silent (failures are still
 * logged via the logger).
 * @returns `"described"` when at least one new description was stored,
 * `"skipped"` when there was nothing new to describe (including a note path
 * that no longer resolves to a Markdown file), and `"failed"` when the run
 * threw or every new image failed.
 */
export async function describeNoteImages(
  plugin: CopilotPlugin,
  notePath: string,
  dependencies: DescribeImageDependencies = {}
): Promise<DescribeNoteImagesResult> {
  const now = dependencies.now ?? (() => new Date());
  const describeImage = dependencies.describeImage ?? defaultDescribeImage;
  const maxImagesPerRun = dependencies.maxImagesPerRun ?? MAX_IMAGES_PER_RUN;
  const quiet = dependencies.quiet ?? false;

  const resolved = plugin.app.vault.getAbstractFileByPath(notePath);
  const noteFile =
    resolved instanceof TFile && resolved.extension?.toLowerCase() === "md" ? resolved : null;
  if (!noteFile) {
    if (!quiet) new Notice(OPEN_NOTE_NOTICE);
    return "skipped";
  }

  try {
    const io = dependencies.io ?? createVaultImageDescriptionIO(plugin.app.vault);
    const createReader = dependencies.createReader ?? (() => createVaultImageReader(plugin.app));
    const store = new ImageDescriptionStore(io);
    const reader = await createReader();
    const noteText = await plugin.app.vault.read(noteFile);

    const references = parseEmbeddedAssetReferences(noteText);
    if (references.length === 0) {
      if (!quiet) new Notice(NO_IMAGES_NOTICE);
      return "skipped";
    }
    const selected = references.slice(0, maxImagesPerRun);

    let described = 0;
    let skipped = 0;
    let failed = 0;
    let lastFailureReason = "";

    for (const reference of selected) {
      try {
        const resolution = await resolveEmbeddedLocalImage(
          reference.reference,
          noteFile.path,
          reader
        );
        if (resolution.status !== "resolved") {
          failed += 1;
          lastFailureReason = `"${resolution.reference}" unresolved (${resolution.reason})`;
          logWarn(`Unresolved embedded reference: ${lastFailureReason}`);
          continue;
        }

        const digest = resolution.source.contentDigest;
        if (await store.get(digest)) {
          skipped += 1;
          continue;
        }
        if (resolution.bytes.byteLength > ATTACHMENT_MAX_BYTES) {
          throw new Error("Image exceeds the 3 MB limit");
        }
        const description = await describeBoundedImage(
          describeImage,
          resolution.mimeType,
          resolution.bytes
        );
        const entry: PutImageDescriptionInput = {
          digest,
          description,
          vaultPath: resolution.source.vaultPath,
          updatedAt: now().toISOString(),
        };
        await store.put(entry);
        described += 1;
      } catch (error) {
        failed += 1;
        lastFailureReason = formatFailureReason(error);
        logError("Describe one image failed:", error);
      }
    }

    const newCount = selected.length - skipped;
    if (described === 0 && failed > 0 && failed === newCount) {
      if (!quiet) {
        new Notice(
          `All ${newCount} new image${newCount === 1 ? "" : "s"} failed: ${lastFailureReason}`
        );
      }
      return "failed";
    }

    const capNote =
      references.length > maxImagesPerRun
        ? `. Only the first ${maxImagesPerRun} of ${references.length} images were processed.`
        : "";
    if (!quiet) {
      new Notice(
        `Described ${described}, skipped ${skipped}, failed ${failed} (of ${selected.length})${capNote}`
      );
    }
    return described > 0 ? "described" : "skipped";
  } catch (error) {
    logError("Describe images failed:", error);
    if (!quiet) new Notice(FAILURE_NOTICE);
    return "failed";
  }
}

/**
 * Create the "Describe active note images for search" command descriptor.
 *
 * The command resolves the active note and delegates to
 * {@link describeNoteImages} with the command's injected seams.
 *
 * @param plugin - Plugin instance that owns the current Obsidian application.
 * @param dependencies - Optional seams for synthetic tests.
 * @returns An Obsidian command descriptor.
 */
export function createDescribeImageCommand(
  plugin: CopilotPlugin,
  dependencies: DescribeImageDependencies = {}
): Command {
  return {
    id: DESCRIPTION_IMAGES_COMMAND_ID,
    name: DESCRIPTION_IMAGES_COMMAND_NAME,
    callback: async () => {
      const activeFile = getActiveMarkdownFile(plugin.app);
      if (!activeFile) {
        new Notice(OPEN_NOTE_NOTICE);
        return;
      }
      await describeNoteImages(plugin, activeFile.path, dependencies);
    },
  };
}

/**
 * Register the image description command with Obsidian.
 *
 * @param plugin - Plugin instance receiving the command.
 * @param dependencies - Optional seams for tests and host-specific injection.
 */
export function registerDescribeImageCommands(
  plugin: CopilotPlugin,
  dependencies: DescribeImageDependencies = {}
): void {
  plugin.addCommand(createDescribeImageCommand(plugin, dependencies));
}
