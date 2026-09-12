import {
  createLocalImageChatStagingCommand,
  createLocalImagePreparationCommand,
  LOCAL_IMAGE_COMMAND_ID,
  LOCAL_IMAGE_COMMAND_NAME,
  LOCAL_IMAGE_CHAT_STAGING_COMMAND_ID,
  LOCAL_IMAGE_CHAT_STAGING_COMMAND_NAME,
  registerLocalImageCommands,
} from "@/commands/localImageCommands";
import type { AgentSessionLocalAttachmentStagingOptions } from "@/agentMode/session/sessionLocalAttachments";
import {
  createSessionLocalAttachmentStaging,
  type SessionLocalAttachmentStaging,
  type SessionLocalAttachmentTarget,
} from "@/agentMode/session/sessionLocalAttachments";
import type {
  LocalImageRuntimeForCommand,
  LocalImageRuntimeOptionsForCommand,
} from "@/commands/localImageCommands";
import type CopilotPlugin from "@/main";
import { Notice, TFile, type App, type Command } from "obsidian";

interface MockConfirmModal {
  readonly onConfirm: () => void | Promise<void>;
  readonly onCancel?: () => void | Promise<void>;
  readonly content: string;
  readonly title: string;
  readonly open: jest.Mock;
}

const mockConfirmModals: MockConfirmModal[] = [];

jest.mock("@/components/modals/ConfirmModal", () => ({
  ConfirmModal: jest
    .fn()
    .mockImplementation(
      (
        _app: App,
        onConfirm: () => void | Promise<void>,
        content: string,
        title: string,
        _confirmButtonText: string,
        _cancelButtonText: string,
        onCancel?: () => void | Promise<void>
      ) => {
        const modal: MockConfirmModal = {
          onConfirm,
          onCancel,
          content,
          title,
          open: jest.fn(),
        };
        mockConfirmModals.push(modal);
        return modal;
      }
    ),
}));

interface TestHost {
  readonly app: App;
  readonly activeFile: TFile;
  readonly getActiveFile: jest.Mock;
  readonly read: jest.Mock;
}

interface AgentHostFixture {
  readonly plugin: CopilotPlugin;
  readonly target: SessionLocalAttachmentTarget;
  readonly liveTarget: { current: SessionLocalAttachmentTarget | null };
  readonly staging: SessionLocalAttachmentStaging;
  readonly session: {
    readonly internalId: string;
    readonly projectId: string;
    readonly getStatus: jest.Mock;
    readonly getLabel: jest.Mock;
    readonly getLocalAttachmentStaging: jest.MockedFunction<
      (options: AgentSessionLocalAttachmentStagingOptions) => SessionLocalAttachmentStaging
    >;
  };
  readonly manager: {
    readonly getActiveSession: jest.Mock;
    readonly getActiveProjectId: jest.Mock;
  };
}

interface RuntimeFixture {
  readonly runtime: LocalImageRuntimeForCommand;
  readonly preview: jest.Mock;
  readonly issueConfirmation: jest.Mock;
  readonly execute: jest.Mock;
  readonly dispose: jest.Mock;
  readonly confirmation: object;
}

function markdownFile(path: string, scopePath: string, noteText: string): TFile {
  const TFileConstructor = TFile as unknown as new (filePath: string) => TFile;
  const file = new TFileConstructor(path);
  Object.assign(file, {
    extension: "md",
    parent: scopePath ? { path: scopePath } : undefined,
    stat: { size: new TextEncoder().encode(noteText).byteLength },
  });
  return file;
}

function nonMarkdownFile(path: string): TFile {
  const TFileConstructor = TFile as unknown as new (filePath: string) => TFile;
  const file = new TFileConstructor(path);
  Object.assign(file, {
    extension: "canvas",
    parent: undefined,
    stat: { size: 32 },
  });
  return file;
}

function hostWithActiveFile(activeFile: TFile, noteText = "![[image.png]]"): TestHost {
  const getActiveFile = jest.fn(() => activeFile);
  const read = jest.fn().mockResolvedValue(noteText);
  const app = {
    workspace: { getActiveFile },
    vault: { read },
  } as unknown as App;
  return { app, activeFile, getActiveFile, read };
}

function pluginFor(app: App, register?: jest.Mock, agentSessionManager?: unknown): CopilotPlugin {
  return {
    app,
    addCommand: jest.fn(),
    ...(register ? { register } : {}),
    ...(agentSessionManager ? { agentSessionManager } : {}),
  } as unknown as CopilotPlugin;
}

function agentHostFor(host: TestHost): AgentHostFixture {
  const target: SessionLocalAttachmentTarget = {
    sessionId: "session-1",
    projectId: "project-1",
    vaultId: "vault-1",
  };
  const liveTarget: { current: SessionLocalAttachmentTarget | null } = { current: target };
  const getLiveTarget = jest.fn(() => liveTarget.current);
  const staging = createSessionLocalAttachmentStaging({ target, getLiveTarget });
  const getStatus = jest.fn(() => "idle");
  const getLabel = jest.fn(() => "Research chat");
  const getLocalAttachmentStaging = jest.fn<
    SessionLocalAttachmentStaging,
    [AgentSessionLocalAttachmentStagingOptions]
  >((options: AgentSessionLocalAttachmentStagingOptions) => {
    staging.updateLiveTargetGetter(options.getLiveTarget);
    return staging;
  });
  const session = {
    internalId: target.sessionId,
    projectId: target.projectId,
    getStatus,
    getLabel,
    getLocalAttachmentStaging,
  };
  const manager = {
    getActiveSession: jest.fn(() => session),
    getActiveProjectId: jest.fn(() => target.projectId),
  };
  return {
    plugin: pluginFor(host.app, undefined, manager),
    target,
    liveTarget,
    staging,
    session,
    manager,
  };
}

function runtimeFixture(): RuntimeFixture {
  const confirmation = Object.freeze({ token: "confirmation-1" });
  const preview = jest.fn().mockResolvedValue({
    previewId: "preview-1",
    notePath: "Notes/Active.md",
    scopePath: "Notes",
    candidates: [{ reference: "image.png", syntax: "wiki" }],
    candidateCount: 1,
    rejectedCount: 0,
    truncated: false,
    omittedCount: 0,
    storageRoot: "/tmp/home/.obsidian-copilot/vaults/vault-1/attachments",
  });
  const issueConfirmation = jest.fn(() => confirmation);
  const execute = jest.fn().mockResolvedValue({
    persistedCount: 1,
    items: [{ status: "persisted" }],
    truncated: false,
  });
  const dispose = jest.fn().mockResolvedValue(undefined);
  const runtime = {
    preview,
    issueConfirmation,
    execute,
    restore: jest.fn(),
    dispose,
  } as unknown as LocalImageRuntimeForCommand;
  return { runtime, preview, issueConfirmation, execute, dispose, confirmation };
}

function commandFor(
  host: TestHost,
  fixture: RuntimeFixture,
  overrides: {
    readonly getVaultId?: () => string | Promise<string>;
    readonly isDesktopRuntime?: () => boolean;
  } = {}
): Command {
  return createLocalImagePreparationCommand(pluginFor(host.app), {
    createRuntime: jest.fn().mockResolvedValue(fixture.runtime),
    getVaultId: overrides.getVaultId ?? (() => "vault-1"),
    getHomeDir: () => "/tmp/home",
    isDesktopRuntime: overrides.isDesktopRuntime ?? (() => true),
  });
}

describe("localImageCommands", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfirmModals.length = 0;
  });

  describe("createLocalImagePreparationCommand()", () => {
    it("previews bounded note context and waits for native consent before issuing or executing", async () => {
      const noteText = "```md\n![[image.png]]\n```";
      const host = hostWithActiveFile(markdownFile("Notes/Active.md", "Notes", noteText), noteText);
      const fixture = runtimeFixture();
      const createRuntime = jest.fn().mockResolvedValue(fixture.runtime);
      const command = createLocalImagePreparationCommand(pluginFor(host.app), {
        createRuntime,
        getVaultId: () => "vault-1",
        getHomeDir: () => "/tmp/home",
        isDesktopRuntime: () => true,
      });

      await command.callback?.();

      expect(host.read).toHaveBeenCalledWith(host.activeFile);
      expect(createRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          app: host.app,
          vault: host.app.vault,
          vaultId: "vault-1",
          homeDir: "/tmp/home",
        })
      );
      const runtimeOptions = createRuntime.mock.calls[0][0] as LocalImageRuntimeOptionsForCommand;
      expect(typeof runtimeOptions.isDesktopRuntime).toBe("function");
      await expect(runtimeOptions.getLiveScope()).resolves.toEqual({
        vaultId: "vault-1",
        notePath: "Notes/Active.md",
        scopePath: "Notes",
      });
      expect(fixture.preview).toHaveBeenCalledWith({
        notePath: "Notes/Active.md",
        scopePath: "Notes",
        noteText,
      });
      expect(fixture.issueConfirmation).not.toHaveBeenCalled();
      expect(fixture.execute).not.toHaveBeenCalled();
      expect(mockConfirmModals).toHaveLength(1);
      expect(mockConfirmModals[0].title).toBe(LOCAL_IMAGE_COMMAND_NAME);
      expect(mockConfirmModals[0].content).toContain(
        "Allowed folder scope: Notes (and descendants)"
      );
      expect(mockConfirmModals[0].content).toContain("Candidates: image.png");
      expect(mockConfirmModals[0].content).toContain("No model or network request will be made.");
      expect(mockConfirmModals[0].open).toHaveBeenCalled();

      await mockConfirmModals[0].onConfirm();

      expect(fixture.issueConfirmation).toHaveBeenCalledWith("preview-1");
      expect(fixture.execute).toHaveBeenCalledWith({ confirmation: fixture.confirmation });
      expect(fixture.execute.mock.calls[0][0]).not.toHaveProperty("currentSelection");
      expect(fixture.dispose).toHaveBeenCalledTimes(1);
      expect(Notice).toHaveBeenCalledWith(
        "Saved 1 local image. Nothing was sent to a model or network."
      );
    });

    it("cancels with no confirmation, execution, or attachment disposal side effect", async () => {
      const host = hostWithActiveFile(markdownFile("Active.md", "", "![[image.png]]"));
      const fixture = runtimeFixture();
      const command = commandFor(host, fixture);

      await command.callback?.();
      await mockConfirmModals[0].onCancel?.();

      expect(fixture.issueConfirmation).not.toHaveBeenCalled();
      expect(fixture.execute).not.toHaveBeenCalled();
      expect(fixture.dispose).toHaveBeenCalledTimes(1);
    });

    it("rejects a changed active note or scope before token issuance", async () => {
      const initialFile = markdownFile("Notes/Active.md", "Notes", "![[image.png]]");
      const changedFile = markdownFile("Other/Changed.md", "Other", "![[image.png]]");
      const host = hostWithActiveFile(initialFile);
      const fixture = runtimeFixture();
      const command = commandFor(host, fixture);

      await command.callback?.();
      host.getActiveFile.mockReturnValue(changedFile);
      await mockConfirmModals[0].onConfirm();

      expect(fixture.issueConfirmation).not.toHaveBeenCalled();
      expect(fixture.execute).not.toHaveBeenCalled();
      expect(fixture.dispose).toHaveBeenCalledTimes(1);
      expect(Notice).toHaveBeenCalledWith(
        "The active note or allowed folder changed. Run the command again."
      );
    });

    it("reports a changed vault separately before token issuance", async () => {
      const host = hostWithActiveFile(markdownFile("Notes/Active.md", "Notes", "![[image.png]]"));
      const fixture = runtimeFixture();
      let vaultId = "vault-1";
      const command = commandFor(host, fixture, { getVaultId: () => vaultId });

      await command.callback?.();
      vaultId = "vault-2";
      await mockConfirmModals[0].onConfirm();

      expect(fixture.issueConfirmation).not.toHaveBeenCalled();
      expect(fixture.execute).not.toHaveBeenCalled();
      expect(fixture.dispose).toHaveBeenCalledTimes(1);
      expect(Notice).toHaveBeenCalledWith("The active vault changed. Run the command again.");
    });

    it("reports bounded partial preparation counts without exposing source details", async () => {
      const host = hostWithActiveFile(markdownFile("Notes/Active.md", "Notes", "![[image.png]]"));
      const fixture = runtimeFixture();
      fixture.execute.mockResolvedValue({
        persistedCount: 1,
        items: [
          { status: "persisted", reference: "/secret/private.png" },
          { status: "rejected", reference: "/secret/rejected.png" },
          { status: "failed", reference: "/secret/failed.png" },
          { status: "skipped", reference: "/secret/skipped.png" },
        ],
        truncated: true,
      });
      const command = commandFor(host, fixture);

      await command.callback?.();
      await mockConfirmModals[0].onConfirm();

      expect(Notice).toHaveBeenCalledWith(
        "Saved 1 local image. Rejected 1. Failed 1. Skipped 1. The bounded input was truncated (1 item). Nothing was sent to a model or network."
      );
      expect(Notice).not.toHaveBeenCalledWith(expect.stringContaining("/secret/"));
    });

    it.each([
      ["no active file", null],
      ["a non-Markdown active file", nonMarkdownFile("Canvas.canvas")],
    ])("fails locally for %s", async (_label, activeFile) => {
      const getActiveFile = jest.fn(() => activeFile);
      const read = jest.fn();
      const app = {
        workspace: { getActiveFile },
        vault: { read },
      } as unknown as App;
      const fixture = runtimeFixture();
      const createRuntime = jest.fn().mockResolvedValue(fixture.runtime);
      const command = createLocalImagePreparationCommand(pluginFor(app), {
        createRuntime,
        getVaultId: () => "vault-1",
        getHomeDir: () => "/tmp/home",
        isDesktopRuntime: () => true,
      });

      await command.callback?.();

      expect(read).not.toHaveBeenCalled();
      expect(createRuntime).not.toHaveBeenCalled();
      expect(Notice).toHaveBeenCalledWith(
        "Open an active Markdown note before preparing local images."
      );
    });

    it("rejects an oversized note before reading or creating a runtime", async () => {
      const largeFile = markdownFile("Notes/Large.md", "Notes", "");
      Object.assign(largeFile, { stat: { size: 512 * 1024 + 1 } });
      const host = hostWithActiveFile(largeFile);
      const fixture = runtimeFixture();
      const createRuntime = jest.fn().mockResolvedValue(fixture.runtime);
      const command = createLocalImagePreparationCommand(pluginFor(host.app), {
        createRuntime,
        getVaultId: () => "vault-1",
        getHomeDir: () => "/tmp/home",
        isDesktopRuntime: () => true,
      });

      await command.callback?.();

      expect(host.read).not.toHaveBeenCalled();
      expect(createRuntime).not.toHaveBeenCalled();
      expect(Notice).toHaveBeenCalledWith(
        "Local image preparation failed. No model or network request was made."
      );
    });

    it("fails locally on an unsupported host without reading the active note", async () => {
      const host = hostWithActiveFile(markdownFile("Active.md", "", "![[image.png]]"));
      const fixture = runtimeFixture();
      const command = commandFor(host, fixture, { isDesktopRuntime: () => false });

      await command.callback?.();

      expect(host.read).not.toHaveBeenCalled();
      expect(fixture.preview).not.toHaveBeenCalled();
      expect(Notice).toHaveBeenCalledWith("Local image preparation is only available on desktop.");
    });
  });

  describe("createLocalImageChatStagingCommand()", () => {
    it("fails locally without an existing active Agent Chat session", async () => {
      const host = hostWithActiveFile(markdownFile("Active.md", "", "![[image.png]]"));
      const fixture = runtimeFixture();
      const command = createLocalImageChatStagingCommand(pluginFor(host.app), {
        createRuntime: jest.fn().mockResolvedValue(fixture.runtime),
        getVaultId: () => "vault-1",
        getHomeDir: () => "/tmp/home",
        isDesktopRuntime: () => true,
      });

      await command.callback?.();

      expect(host.read).not.toHaveBeenCalled();
      expect(fixture.preview).not.toHaveBeenCalled();
      expect(Notice).toHaveBeenCalledWith(
        "Open an existing Agent Chat session before preparing images for it."
      );
    });

    it("uses the final session staging API only after explicit consent and stages inert refs", async () => {
      const host = hostWithActiveFile(markdownFile("Notes/Active.md", "Notes", "![[image.png]]"));
      const agent = agentHostFor(host);
      const fixture = runtimeFixture();
      fixture.execute.mockResolvedValue({
        persisted: [
          {
            schemaVersion: 1,
            attachmentId: "attachment-1",
            mediaType: "image/png",
            extension: "png",
            byteLength: 4,
            contentDigest: "a".repeat(64),
            source: {
              kind: "vault",
              vaultId: "vault-1",
              vaultPath: "Notes/image.png",
            },
          },
        ],
        persistedCount: 1,
        items: [{ status: "persisted" }],
        truncated: false,
      });
      const command = createLocalImageChatStagingCommand(agent.plugin, {
        createRuntime: jest.fn().mockResolvedValue(fixture.runtime),
        getVaultId: () => "vault-1",
        getHomeDir: () => "/tmp/home",
        isDesktopRuntime: () => true,
      });

      await command.callback?.();

      expect(mockConfirmModals).toHaveLength(1);
      expect(agent.session.getLocalAttachmentStaging).not.toHaveBeenCalled();
      expect(fixture.issueConfirmation).not.toHaveBeenCalled();
      expect(fixture.execute).not.toHaveBeenCalled();
      expect(mockConfirmModals[0].title).toBe(LOCAL_IMAGE_CHAT_STAGING_COMMAND_NAME);
      expect(mockConfirmModals[0].content).toContain(
        "Destination Agent chat: Research chat; project scope project-1"
      );
      expect(mockConfirmModals[0].content).toContain(
        "stored locally and staged only for this chat; they will not be sent to the model"
      );
      expect(mockConfirmModals[0].content).toContain("not included automatically in the next send");

      expect(agent.staging.getSnapshot().refs).toHaveLength(0);
      await mockConfirmModals[0].onConfirm();

      expect(fixture.issueConfirmation).toHaveBeenCalledWith("preview-1");
      expect(fixture.execute).toHaveBeenCalledWith({ confirmation: fixture.confirmation });
      expect(fixture.execute.mock.calls[0][0]).not.toHaveProperty("currentSelection");
      const stagingOptions = agent.session.getLocalAttachmentStaging.mock.calls.at(0)?.[0];
      expect(stagingOptions).toBeDefined();
      expect(stagingOptions?.vaultId).toBe("vault-1");
      expect(typeof stagingOptions?.getLiveTarget).toBe("function");
      expect(agent.staging.getSnapshot().refs).toEqual([
        { schemaVersion: 1, vaultId: "vault-1", attachmentId: "attachment-1" },
      ]);
      expect(fixture.dispose).toHaveBeenCalledTimes(1);
      expect(Notice).toHaveBeenCalledWith(
        expect.stringContaining("Staged 1 local image reference for this Agent chat.")
      );
    });

    it("retains local records and stages nothing when the Agent Chat target changes after execution", async () => {
      const host = hostWithActiveFile(markdownFile("Notes/Active.md", "Notes", "![[image.png]]"));
      const agent = agentHostFor(host);
      const changedSession = {
        internalId: "session-2",
        projectId: "project-2",
        getStatus: jest.fn(() => "idle"),
      };
      const fixture = runtimeFixture();
      fixture.execute.mockImplementation(async () => {
        agent.liveTarget.current = {
          sessionId: changedSession.internalId,
          projectId: changedSession.projectId,
          vaultId: "vault-1",
        };
        agent.manager.getActiveSession.mockReturnValue(changedSession);
        agent.manager.getActiveProjectId.mockReturnValue(changedSession.projectId);
        return {
          persisted: [
            {
              schemaVersion: 1,
              attachmentId: "attachment-1",
              mediaType: "image/png",
              extension: "png",
              byteLength: 4,
              contentDigest: "b".repeat(64),
              source: { kind: "vault", vaultId: "vault-1", vaultPath: "Notes/image.png" },
            },
          ],
          persistedCount: 1,
          items: [{ status: "persisted" }],
        };
      });
      const command = createLocalImageChatStagingCommand(agent.plugin, {
        createRuntime: jest.fn().mockResolvedValue(fixture.runtime),
        getVaultId: () => "vault-1",
        getHomeDir: () => "/tmp/home",
        isDesktopRuntime: () => true,
      });

      await command.callback?.();
      await mockConfirmModals[0].onConfirm();

      expect(fixture.issueConfirmation).toHaveBeenCalledWith("preview-1");
      expect(fixture.execute).toHaveBeenCalledTimes(1);
      expect(agent.session.getLocalAttachmentStaging).not.toHaveBeenCalled();
      expect(agent.staging.getSnapshot().refs).toHaveLength(0);
      expect(fixture.dispose).toHaveBeenCalledTimes(1);
      expect(Notice).toHaveBeenCalledWith(
        expect.stringContaining(
          "The Agent Chat target changed before staging. Local records were retained; nothing was staged."
        )
      );
    });

    it("does not open the confirmation when the target changes during preview", async () => {
      const host = hostWithActiveFile(markdownFile("Notes/Active.md", "Notes", "![[image.png]]"));
      const agent = agentHostFor(host);
      const fixture = runtimeFixture();
      fixture.preview.mockImplementation(async () => {
        agent.liveTarget.current = {
          sessionId: "session-2",
          projectId: "project-2",
          vaultId: "vault-1",
        };
        agent.manager.getActiveSession.mockReturnValue({
          internalId: "session-2",
          projectId: "project-2",
          getStatus: jest.fn(() => "idle"),
        });
        agent.manager.getActiveProjectId.mockReturnValue("project-2");
        return {
          previewId: "preview-1",
          notePath: "Notes/Active.md",
          scopePath: "Notes",
          candidates: [],
          candidateCount: 0,
          rejectedCount: 0,
          truncated: false,
          omittedCount: 0,
          maxInputs: 64,
          maxPersistedReferences: 16,
          maxImageBytes: 3 * 1024 * 1024,
          storageRoot: "/tmp/home/.obsidian-copilot/attachments",
        };
      });
      const command = createLocalImageChatStagingCommand(agent.plugin, {
        createRuntime: jest.fn().mockResolvedValue(fixture.runtime),
        getVaultId: () => "vault-1",
        getHomeDir: () => "/tmp/home",
        isDesktopRuntime: () => true,
      });

      await command.callback?.();

      expect(mockConfirmModals).toHaveLength(0);
      expect(fixture.issueConfirmation).not.toHaveBeenCalled();
      expect(fixture.execute).not.toHaveBeenCalled();
      expect(fixture.dispose).toHaveBeenCalledTimes(1);
      expect(Notice).toHaveBeenCalledWith("The Agent Chat target changed. Run the command again.");
    });
  });

  describe("registerLocalImageCommands()", () => {
    it("registers both explicit local-image commands and hooks runtime disposal to plugin teardown", async () => {
      const host = hostWithActiveFile(markdownFile("Active.md", "", "![[image.png]]"));
      const fixture = runtimeFixture();
      const register = jest.fn();
      const plugin = pluginFor(host.app, register);
      const createRuntime = jest.fn().mockResolvedValue(fixture.runtime);
      const getVaultId = jest.fn(() => "vault-1");
      registerLocalImageCommands(plugin, {
        createRuntime,
        getVaultId,
        getHomeDir: () => "/tmp/home",
        isDesktopRuntime: () => true,
      });

      const commands = (plugin.addCommand as unknown as jest.Mock).mock.calls.map(
        ([command]: [Command]) => command
      );
      expect(commands).toHaveLength(2);
      expect(commands[0]).toMatchObject({
        id: LOCAL_IMAGE_COMMAND_ID,
        name: LOCAL_IMAGE_COMMAND_NAME,
        icon: "image-down",
      });
      expect(commands[1]).toMatchObject({
        id: LOCAL_IMAGE_CHAT_STAGING_COMMAND_ID,
        name: LOCAL_IMAGE_CHAT_STAGING_COMMAND_NAME,
        icon: "image-down",
      });
      expect(register).toHaveBeenCalledTimes(1);
      expect(createRuntime).not.toHaveBeenCalled();
      expect(getVaultId).not.toHaveBeenCalled();

      await commands[0].callback?.();
      expect(getVaultId).toHaveBeenCalled();
      expect(createRuntime).toHaveBeenCalledTimes(1);
      const disposeOnUnload = register.mock.calls[0][0] as () => void;
      disposeOnUnload();
      expect(fixture.dispose).toHaveBeenCalledTimes(1);
    });

    it("does not register the command outside the desktop runtime", () => {
      const host = hostWithActiveFile(markdownFile("Active.md", "", "![[image.png]]"));
      const plugin = pluginFor(host.app, jest.fn());

      registerLocalImageCommands(plugin, { isDesktopRuntime: () => false });

      expect(plugin.addCommand).not.toHaveBeenCalled();
      expect(plugin.register).not.toHaveBeenCalled();
    });
  });
});
