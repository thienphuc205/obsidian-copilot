import {
  createNewResearchNoteCommand,
  promptForResearchTopic,
  RESEARCH_COMMAND_ID,
  RESEARCH_COMMAND_NAME,
  registerResearchCommands,
  sanitizeTopicFilename,
  scaffoldResearchNote,
} from "@/commands/researchCommands";
import type CopilotPlugin from "@/main";
import { Modal, Notice, TFile, type App, type Command, type Vault } from "obsidian";

jest.mock("@/logger", () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

jest.mock("@/utils", () => ({
  ensureFolderExists: jest.fn(async () => {}),
}));

import { ensureFolderExists } from "@/utils";

function newTFile(path: string): TFile {
  const TFileConstructor = TFile as unknown as new (filePath: string) => TFile;
  return new TFileConstructor(path);
}

interface ResearchHostFixture {
  readonly app: App;
  readonly vault: Vault;
  readonly getAbstractFileByPath: jest.Mock;
  readonly create: jest.Mock;
  readonly createdFiles: TFile[];
  readonly getLeaf: jest.Mock;
  readonly openFile: jest.Mock;
}

function hostFor(): ResearchHostFixture {
  const openFile = jest.fn().mockResolvedValue(undefined);
  const getLeaf = jest.fn(() => ({ openFile }));
  const getAbstractFileByPath = jest.fn(() => null);
  const createdFiles: TFile[] = [];
  const create = jest.fn(async (path: string) => {
    const file = newTFile(path);
    createdFiles.push(file);
    return file;
  });
  const vault = { getAbstractFileByPath, create } as unknown as Vault;
  const app = { workspace: { getLeaf }, vault } as unknown as App;
  return {
    app,
    vault,
    getAbstractFileByPath,
    create,
    createdFiles,
    getLeaf,
    openFile,
  };
}

function pluginFor(app: App, addCommand: jest.Mock = jest.fn()): CopilotPlugin {
  return { app, addCommand } as unknown as CopilotPlugin;
}

function fixedClock(): () => Date {
  return () => new Date(2026, 8, 11, 10, 30, 0);
}

const DATE_LABEL = "2026-09-11";

function expectedContent(topic: string): string {
  return [
    "---",
    "tags:",
    "  - research",
    `date: ${DATE_LABEL}`,
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

function commandFor(
  host: ResearchHostFixture,
  overrides: {
    readonly promptTopic?: () => Promise<string | null>;
    readonly now?: () => Date;
  } = {}
): Command {
  return createNewResearchNoteCommand(pluginFor(host.app), {
    promptTopic: overrides.promptTopic ?? jest.fn().mockResolvedValue("Deep sea"),
    now: overrides.now ?? fixedClock(),
  });
}

describe("researchCommands", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("registerResearchCommands()", () => {
    it("registers one research note command and runs the full scaffold flow from its callback", async () => {
      const host = hostFor();
      const addCommand = jest.fn();
      const promptTopic = jest.fn().mockResolvedValue("Time travel");
      registerResearchCommands(pluginFor(host.app, addCommand), { promptTopic, now: fixedClock() });

      expect(addCommand).toHaveBeenCalledTimes(1);
      const [command] = addCommand.mock.calls[0] as [Command];
      expect(command).toMatchObject({
        id: RESEARCH_COMMAND_ID,
        name: RESEARCH_COMMAND_NAME,
      });

      await command.callback?.();

      expect(promptTopic).toHaveBeenCalledTimes(1);
      expect(ensureFolderExists).toHaveBeenCalledWith(host.vault, "Research");
      expect(host.create).toHaveBeenCalledWith(
        "Research/Time travel (2026-09-11).md",
        expectedContent("Time travel")
      );
      expect(host.openFile).toHaveBeenCalledWith(host.createdFiles[0]);
      expect(Notice).not.toHaveBeenCalled();
    });
  });

  describe("createNewResearchNoteCommand()", () => {
    it("creates the exact template note with the injected date and opens it in a new leaf", async () => {
      const host = hostFor();
      const command = commandFor(host, {
        promptTopic: jest.fn().mockResolvedValue("Ocean currents"),
      });

      await command.callback?.();

      expect(host.getLeaf).toHaveBeenCalledWith(true);
      expect(host.create).toHaveBeenCalledWith(
        "Research/Ocean currents (2026-09-11).md",
        expectedContent("Ocean currents")
      );
      expect(host.openFile).toHaveBeenCalledWith(host.createdFiles[0]);
      expect(Notice).not.toHaveBeenCalled();
    });

    it("does nothing and notifies no one when the topic prompt is cancelled", async () => {
      const host = hostFor();
      const command = commandFor(host, { promptTopic: jest.fn().mockResolvedValue(null) });

      await command.callback?.();

      expect(host.getAbstractFileByPath).not.toHaveBeenCalled();
      expect(ensureFolderExists).not.toHaveBeenCalled();
      expect(host.create).not.toHaveBeenCalled();
      expect(host.openFile).not.toHaveBeenCalled();
      expect(Notice).not.toHaveBeenCalled();
    });

    it("does nothing when the topic prompt returns blank input", async () => {
      const host = hostFor();
      const command = commandFor(host, { promptTopic: jest.fn().mockResolvedValue("   ") });

      await command.callback?.();

      expect(host.getAbstractFileByPath).not.toHaveBeenCalled();
      expect(ensureFolderExists).not.toHaveBeenCalled();
      expect(host.create).not.toHaveBeenCalled();
      expect(host.openFile).not.toHaveBeenCalled();
      expect(Notice).not.toHaveBeenCalled();
    });

    it("does nothing when nothing usable remains after sanitization", async () => {
      const host = hostFor();
      const command = commandFor(host, {
        promptTopic: jest.fn().mockResolvedValue(`#^[]|:*?"\\<>`),
      });

      await command.callback?.();

      expect(ensureFolderExists).not.toHaveBeenCalled();
      expect(host.create).not.toHaveBeenCalled();
      expect(host.openFile).not.toHaveBeenCalled();
      expect(Notice).not.toHaveBeenCalled();
    });

    it("strips characters illegal in Obsidian filenames from the note path", async () => {
      const host = hostFor();
      const command = commandFor(host, {
        promptTopic: jest.fn().mockResolvedValue(`  My   Topic: "part-1"? <>[]|^#  `),
      });

      await command.callback?.();

      expect(host.create).toHaveBeenCalledWith(
        "Research/My Topic part-1 (2026-09-11).md",
        expectedContent("My Topic part-1")
      );
    });

    it("caps the sanitized topic at 80 characters in the note path", async () => {
      const host = hostFor();
      const command = commandFor(host, {
        promptTopic: jest.fn().mockResolvedValue("a".repeat(120)),
      });

      await command.callback?.();

      const cappedTopic = "a".repeat(80);
      expect(host.create).toHaveBeenCalledWith(
        `Research/${cappedTopic} (2026-09-11).md`,
        expectedContent(cappedTopic)
      );
    });

    it("suffixes the filename by 2 on a path collision", async () => {
      const host = hostFor();
      host.getAbstractFileByPath.mockImplementation((path: string) =>
        path === "Research/Deep sea (2026-09-11).md" ? newTFile(path) : null
      );

      await commandFor(host).callback?.();

      expect(host.create).toHaveBeenCalledWith(
        "Research/Deep sea (2026-09-11) 2.md",
        expectedContent("Deep sea")
      );
    });

    it("keeps counting suffixes while earlier ones are taken", async () => {
      const host = hostFor();
      host.getAbstractFileByPath.mockImplementation((path: string) =>
        path === "Research/Ice ages (2026-09-11).md" ||
        path === "Research/Ice ages (2026-09-11) 2.md"
          ? newTFile(path)
          : null
      );

      await commandFor(host, {
        promptTopic: jest.fn().mockResolvedValue("Ice ages"),
      }).callback?.();

      expect(host.create).toHaveBeenCalledWith(
        "Research/Ice ages (2026-09-11) 3.md",
        expectedContent("Ice ages")
      );
    });

    it("stops suffixing at 99 and reports the unresolved collision as a failure", async () => {
      const host = hostFor();
      host.getAbstractFileByPath.mockImplementation((path: string) => newTFile(path));
      host.create.mockRejectedValue(new Error("File already exists"));

      await commandFor(host, {
        promptTopic: jest.fn().mockResolvedValue("Crowded"),
      }).callback?.();

      expect(host.create).toHaveBeenCalledWith(
        "Research/Crowded (2026-09-11) 99.md",
        expectedContent("Crowded")
      );
      expect(host.openFile).not.toHaveBeenCalled();
      expect(Notice).toHaveBeenCalledWith("Failed to create the research note.");
    });

    it("ensures the Research folder exists before creating the note", async () => {
      const host = hostFor();
      const command = commandFor(host, {
        promptTopic: jest.fn().mockResolvedValue("Plate tectonics"),
      });

      await command.callback?.();

      expect(ensureFolderExists).toHaveBeenCalledTimes(1);
      expect(ensureFolderExists).toHaveBeenCalledWith(host.vault, "Research");
    });

    it("shows a failure notice and opens no leaf when note creation fails", async () => {
      const host = hostFor();
      host.create.mockRejectedValue(new Error("disk full"));
      const command = commandFor(host, {
        promptTopic: jest.fn().mockResolvedValue("Solar flares"),
      });

      await command.callback?.();

      expect(ensureFolderExists).toHaveBeenCalledWith(host.vault, "Research");
      expect(host.openFile).not.toHaveBeenCalled();
      expect(Notice).toHaveBeenCalledTimes(1);
      expect(Notice).toHaveBeenCalledWith("Failed to create the research note.");
    });
  });

  describe("scaffoldResearchNote()", () => {
    it("scaffolds the templated note for a raw topic, opens it, and returns its path", async () => {
      const host = hostFor();

      const path = await scaffoldResearchNote(pluginFor(host.app), "Ocean currents", {
        now: fixedClock(),
      });

      expect(path).toBe("Research/Ocean currents (2026-09-11).md");
      expect(host.create).toHaveBeenCalledWith(
        "Research/Ocean currents (2026-09-11).md",
        expectedContent("Ocean currents")
      );
      expect(host.openFile).toHaveBeenCalledWith(host.createdFiles[0]);
      expect(Notice).not.toHaveBeenCalled();
    });

    it("returns null without touching the vault for a blank or unsanitizable topic", async () => {
      const host = hostFor();
      const plugin = pluginFor(host.app);

      await expect(
        scaffoldResearchNote(plugin, "   ", { now: fixedClock(), quiet: true })
      ).resolves.toBeNull();
      await expect(
        scaffoldResearchNote(plugin, `#^[]|:*?"\\<>`, { now: fixedClock(), quiet: true })
      ).resolves.toBeNull();

      expect(host.getAbstractFileByPath).not.toHaveBeenCalled();
      expect(host.create).not.toHaveBeenCalled();
      expect(Notice).not.toHaveBeenCalled();
    });

    it("returns null and stays silent in quiet mode when creation fails", async () => {
      const host = hostFor();
      host.create.mockRejectedValue(new Error("disk full"));

      const path = await scaffoldResearchNote(pluginFor(host.app), "Solar flares", {
        now: fixedClock(),
        quiet: true,
      });

      expect(path).toBeNull();
      expect(host.openFile).not.toHaveBeenCalled();
      expect(Notice).not.toHaveBeenCalled();
    });

    it("notifies the failure and returns null when creation fails outside quiet mode", async () => {
      const host = hostFor();
      host.create.mockRejectedValue(new Error("disk full"));

      const path = await scaffoldResearchNote(pluginFor(host.app), "Solar flares", {
        now: fixedClock(),
      });

      expect(path).toBeNull();
      expect(Notice).toHaveBeenCalledTimes(1);
      expect(Notice).toHaveBeenCalledWith("Failed to create the research note.");
    });
  });

  describe("promptForResearchTopic()", () => {
    // The mock Modal lacks the (documented but untyped) setTitle used in the
    // subclass constructor; only this suite constructs the real modal, and the
    // hook doubles as the handle to each constructed modal's submit callbacks.
    interface PromptModalHandle {
      args: { onSubmit: (topic: string) => void; onCancel: () => void };
    }
    const constructed: PromptModalHandle[] = [];

    beforeEach(() => {
      constructed.length = 0;
      (Modal as unknown as { prototype: { setTitle: unknown } }).prototype.setTitle =
        function mockSetTitle(this: PromptModalHandle) {
          constructed.push(this);
        };
    });

    it("resolves the submitted topic through the native modal and null on cancel", async () => {
      const host = hostFor();

      const first = promptForResearchTopic(host.app);
      constructed[0].args.onSubmit("Deep sea");
      await expect(first).resolves.toBe("Deep sea");

      const second = promptForResearchTopic(host.app);
      constructed[1].args.onCancel();
      await expect(second).resolves.toBeNull();
    });
  });

  describe("sanitizeTopicFilename()", () => {
    it("strips illegal filename characters and control characters", () => {
      expect(sanitizeTopicFilename(`a#^[]|:*?"\\<>b\tc\u0000d`)).toBe("abcd");
    });

    it("collapses whitespace runs and trims the result", () => {
      expect(sanitizeTopicFilename("  Deep   work   ")).toBe("Deep work");
    });

    it("caps the result at 80 characters and drops a cut-off trailing word", () => {
      expect(sanitizeTopicFilename(`${"a".repeat(79)} b`)).toBe("a".repeat(79));
      expect(sanitizeTopicFilename("a".repeat(120)).length).toBe(80);
    });

    it("returns an empty string when nothing usable remains", () => {
      expect(sanitizeTopicFilename(`#^[]|:*?"\\<>`)).toBe("");
    });
  });
});
