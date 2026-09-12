import type CopilotPlugin from "@/main";
import { logError } from "@/logger";
import { ensureFolderExists } from "@/utils";
import type { App, Command, Vault } from "obsidian";
import { Modal, Notice } from "obsidian";

/** Obsidian command id for the research note scaffold entry point. */
export const RESEARCH_COMMAND_ID = "new-research-note";

/** User-facing name for the research note scaffold entry point. */
export const RESEARCH_COMMAND_NAME = "New research note";

/** Vault folder that receives scaffolded research notes. */
export const RESEARCH_FOLDER = "Research";

const TOPIC_PROMPT_TITLE = "New research note";
const TOPIC_PLACEHOLDER = "Research topic";
const MAX_TOPIC_LENGTH = 80;
const MAX_NOTE_SUFFIX = 99;

// Obsidian treats these as illegal characters or link/tag syntax in note names;
// control characters are stripped so whitespace collapsing only sees spaces.
const ILLEGAL_FILENAME_CHARS = /[#^[\]|:*?"\\<>/]/g;
// eslint-disable-next-line no-control-regex -- research note filenames must reject embedded control bytes
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Optional seams so synthetic tests can pin the prompt and the clock. */
export interface ResearchCommandDependencies {
  /**
   * Resolves the topic the user submitted, or null when the prompt was
   * cancelled or dismissed without a submission.
   */
  readonly promptTopic?: () => Promise<string | null>;
  /** Clock used for the note's date label; defaults to the system time. */
  readonly now?: () => Date;
  /**
   * Suppress the failure Notice; callers that report failures themselves
   * (such as the Agent Chat research quick action) use this.
   */
  readonly quiet?: boolean;
}

interface ResearchTopicModalArgs {
  readonly onSubmit: (topic: string) => void;
  readonly onCancel: () => void;
}

/**
 * Native text prompt for the research topic. Deliberately a plain Obsidian
 * `Modal` without a React tree so the scaffold flow stays independent of the
 * chat UI lifecycle.
 */
class ResearchTopicModal extends Modal {
  private readonly args: ResearchTopicModalArgs;
  private confirmed = false;

  constructor(app: App, args: ResearchTopicModalArgs) {
    super(app);
    this.args = args;
    // https://docs.obsidian.md/Reference/TypeScript+API/Modal/setTitle
    // @ts-ignore - setTitle is documented but missing from the typings.
    this.setTitle(TOPIC_PROMPT_TITLE);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("tw-flex", "tw-flex-col", "tw-gap-3");

    const input = contentEl.createEl("input", {
      cls: "tw-w-full",
      attr: { type: "text", placeholder: TOPIC_PLACEHOLDER },
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.submit(input.value);
      }
    });

    const buttonRow = contentEl.createDiv({
      cls: "tw-flex tw-justify-end tw-gap-2 tw-pt-2",
    });
    const cancelBtn = buttonRow.createEl("button", {
      cls: "mod-secondary",
      text: "Cancel",
    });
    cancelBtn.addEventListener("click", () => {
      this.close();
    });
    const confirmBtn = buttonRow.createEl("button", {
      cls: "mod-cta",
      text: "Create",
    });
    confirmBtn.addEventListener("click", () => {
      this.submit(input.value);
    });
  }

  onClose(): void {
    // Cancel covers the Cancel button, ESC, and click-outside; Confirm is the
    // only path that must not resolve the prompt as cancelled.
    if (!this.confirmed) {
      this.args.onCancel();
    }
    this.contentEl.empty();
  }

  private submit(topic: string): void {
    this.confirmed = true;
    this.args.onSubmit(topic);
    this.close();
  }
}

/**
 * Prompt the user for a research topic with the native modal.
 *
 * Exported so other entry points (such as the Agent Chat research quick
 * action) reuse the exact same prompt flow.
 *
 * @param app - Obsidian application the modal is bound to.
 * @returns The submitted topic text, or null when the prompt was dismissed
 * without a submission.
 */
export function promptForResearchTopic(app: App): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const modal = new ResearchTopicModal(app, {
      onSubmit: (topic) => resolve(topic),
      onCancel: () => resolve(null),
    });
    modal.open();
  });
}

/**
 * Turn a raw topic string into a safe single-segment filename.
 *
 * @param rawTopic - Text exactly as the user typed it.
 * @returns The sanitized filename segment, empty when nothing usable remains.
 */
export function sanitizeTopicFilename(rawTopic: string): string {
  const withoutIllegalChars = rawTopic
    .replace(ILLEGAL_FILENAME_CHARS, "")
    .replace(CONTROL_CHARS, "");
  return withoutIllegalChars.replace(/\s+/g, " ").trim().slice(0, MAX_TOPIC_LENGTH).trim();
}

function researchNotePath(topic: string, dateLabel: string, suffix: number | null): string {
  const suffixPart = suffix === null ? "" : ` ${suffix}`;
  return `${RESEARCH_FOLDER}/${topic} (${dateLabel})${suffixPart}.md`;
}

function findAvailableResearchPath(vault: Vault, topic: string, dateLabel: string): string {
  if (!vault.getAbstractFileByPath(researchNotePath(topic, dateLabel, null))) {
    return researchNotePath(topic, dateLabel, null);
  }
  for (let suffix = 2; suffix <= MAX_NOTE_SUFFIX; suffix += 1) {
    const candidate = researchNotePath(topic, dateLabel, suffix);
    if (!vault.getAbstractFileByPath(candidate)) {
      return candidate;
    }
  }
  // Every suffix is taken: hand back the last candidate and let vault.create
  // surface the conflict through the failure notice instead of looping forever.
  return researchNotePath(topic, dateLabel, MAX_NOTE_SUFFIX);
}

function buildResearchNoteContent(topic: string, dateLabel: string): string {
  return [
    "---",
    "tags:",
    "  - research",
    `date: ${dateLabel}`,
    "---",
    "",
    `# ${topic}`,
    "",
    "## Question",
    `${topic} — refine this into one sentence.`,
    "",
    "## Plan",
    "-",
    "",
    "## Findings",
    "## Conflicts and caveats",
    "## Sources",
  ].join("\n");
}

/**
 * Scaffold one research note for a topic.
 *
 * The shared implementation behind {@link createNewResearchNoteCommand} and
 * the Agent Chat research quick action: it sanitizes the topic into a safe
 * filename, scaffolds a templated note under {@link RESEARCH_FOLDER}, and
 * opens it in a new leaf. Blank input and unsanitizable topics are silent
 * no-ops; only creation failures notify.
 *
 * @param plugin - Plugin instance that owns the current Obsidian application.
 * @param topic - Raw topic text exactly as the user typed it.
 * @param dependencies - Optional seams for synthetic tests; `quiet` also
 * suppresses the failure Notice for callers that own failure reporting.
 * @returns The created note's vault path, or null when the topic was
 * unusable or creation failed.
 */
export async function scaffoldResearchNote(
  plugin: CopilotPlugin,
  topic: string,
  dependencies: ResearchCommandDependencies = {}
): Promise<string | null> {
  try {
    const sanitized = sanitizeTopicFilename(topic);
    if (sanitized.length === 0) {
      return null;
    }

    const dateLabel = (dependencies.now ?? (() => new Date()))().toLocaleDateString("en-CA");
    await ensureFolderExists(plugin.app.vault, RESEARCH_FOLDER);
    const path = findAvailableResearchPath(plugin.app.vault, sanitized, dateLabel);
    const file = await plugin.app.vault.create(
      path,
      buildResearchNoteContent(sanitized, dateLabel)
    );

    const leaf = plugin.app.workspace.getLeaf(true);
    await leaf.openFile(file);
    return file.path;
  } catch (error) {
    logError("Failed to create research note:", error);
    if (!dependencies.quiet) {
      new Notice("Failed to create the research note.");
    }
    return null;
  }
}

/**
 * Create the "New research note" command descriptor.
 *
 * The command prompts for a topic and delegates to
 * {@link scaffoldResearchNote} with the command's injected seams.
 * Cancellation, blank input, and unsanitizable topics are silent no-ops; only
 * failures notify.
 *
 * @param plugin - Plugin instance that owns the current Obsidian application.
 * @param dependencies - Optional seams for synthetic tests.
 * @returns An Obsidian command descriptor for the scaffold flow.
 */
export function createNewResearchNoteCommand(
  plugin: CopilotPlugin,
  dependencies: ResearchCommandDependencies = {}
): Command {
  const promptTopic = dependencies.promptTopic ?? (() => promptForResearchTopic(plugin.app));

  return {
    id: RESEARCH_COMMAND_ID,
    name: RESEARCH_COMMAND_NAME,
    callback: async () => {
      const rawTopic = await promptTopic();
      if (typeof rawTopic !== "string" || rawTopic.trim().length === 0) {
        return;
      }
      await scaffoldResearchNote(plugin, rawTopic, dependencies);
    },
  };
}

/**
 * Register the research note scaffold command with Obsidian.
 *
 * @param plugin - Plugin instance receiving the command.
 * @param dependencies - Optional seams for tests and host-specific injection.
 */
export function registerResearchCommands(
  plugin: CopilotPlugin,
  dependencies: ResearchCommandDependencies = {}
): void {
  plugin.addCommand(createNewResearchNoteCommand(plugin, dependencies));
}
