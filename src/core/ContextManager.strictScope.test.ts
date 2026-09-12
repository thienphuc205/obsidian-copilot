/**
 * Integration coverage for the strict @file/@folder boundary at the context
 * assembly layer. The pure policy tests cover path semantics; this file proves
 * ContextManager actually resolves accepted paths through the current vault.
 */

import { ChainType } from "@/chainType";
import { ChatMessage } from "@/types/message";
import { mockTFile } from "@/__tests__/mockObsidian";
import { App, Vault } from "obsidian";

const mockGetSettings = jest.fn<unknown, unknown[]>();
const mockProcessContextNotes = jest.fn<Promise<string>, unknown[]>();
const mockProcessSelectedTextContexts = jest.fn<string, []>().mockReturnValue("");
const mockProcessContextWebTabs = jest.fn<Promise<string>, unknown[]>();
const mockProcessPrompt = jest.fn<
  Promise<{ processedPrompt: string; includedFiles: unknown[] }>,
  unknown[]
>();
const mockBuildEnvelope = jest.fn<unknown, unknown[]>().mockReturnValue({
  version: 1,
  conversationId: null,
  messageId: "message-1",
  layers: [],
  serializedText: "",
  layerHashes: {},
  combinedHash: "test",
});

jest.mock("@/aiParams", () => ({
  getSelectedTextContexts: jest.fn().mockReturnValue([]),
}));

jest.mock("@/logger", () => ({
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logError: jest.fn(),
}));

jest.mock("@/settings/model", () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
}));

jest.mock("@/contextProcessor", () => ({
  ContextProcessor: {
    getInstance: jest.fn().mockReturnValue({
      processContextNotes: (...args: unknown[]) => mockProcessContextNotes(...args),
      processSelectedTextContexts: () => mockProcessSelectedTextContexts(),
      processContextWebTabs: (...args: unknown[]) => mockProcessContextWebTabs(...args),
    }),
  },
}));

jest.mock("@/context/PromptContextEngine", () => ({
  PromptContextEngine: {
    getInstance: jest.fn().mockReturnValue({
      buildEnvelope: (...args: unknown[]) => mockBuildEnvelope(...args),
    }),
  },
}));

jest.mock("@/commands/customCommandUtils", () => ({
  processPrompt: (...args: unknown[]) => mockProcessPrompt(...args),
}));

// ContextManager reads "@/utils" at require time (tag/folder helpers) and
// MessageRepository uses formatDateTime; the real module is out of this suite's
// scope, so stub the three functions the reachable paths need.
jest.mock("@/utils", () => ({
  getNotesFromPath: jest.fn(() => []),
  getNotesFromTags: jest.fn(() => []),
  formatDateTime: jest.fn(() => ({ fileName: "stub", formatted: "stub" })),
}));

jest.mock("./ContextCompactor", () => ({}));

import { ContextManager } from "./ContextManager";

describe("ContextManager strict context scope", () => {
  let contextManager: ContextManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSettings.mockReturnValue({
      strictContextScope: true,
      autoCompactThreshold: 1_000_000,
    });
    mockProcessPrompt.mockResolvedValue({ processedPrompt: "question", includedFiles: [] });
    mockProcessContextWebTabs.mockResolvedValue("");
    mockProcessContextNotes.mockImplementation((...args: unknown[]) => {
      const notes = args[3] as Array<{ path: string }>;
      return Promise.resolve(notes.map((note) => note.path).join(","));
    });
    mockBuildEnvelope.mockReturnValue({
      version: 1,
      conversationId: null,
      messageId: "message-1",
      layers: [],
      serializedText: "",
      layerHashes: {},
      combinedHash: "test",
    });
    contextManager = ContextManager.getInstance();
  });

  it("resolves explicit files from the current vault and keeps folder prefix boundaries exact", async () => {
    const selectedNote = mockTFile({
      path: "Research/paper.md",
      basename: "paper",
      extension: "md",
    });
    const folderNote = mockTFile({
      path: "Research/inside.md",
      basename: "inside",
      extension: "md",
    });
    const siblingNote = mockTFile({
      path: "Research-old/secret.md",
      basename: "secret",
      extension: "md",
    });
    const vault = {
      getFiles: jest.fn().mockReturnValue([selectedNote, folderNote, siblingNote]),
      getMarkdownFiles: jest.fn().mockReturnValue([selectedNote, folderNote, siblingNote]),
      adapter: { stat: jest.fn().mockResolvedValue(null) },
    } as unknown as Vault;
    const message: ChatMessage = {
      id: "message-1",
      message: "question",
      sender: "user",
      timestamp: null,
      isVisible: true,
      context: {
        notes: [
          selectedNote,
          mockTFile({ path: "missing.md" }),
          mockTFile({ path: "../Research-old/secret.md" }),
        ],
        urls: [],
        folders: ["Research"],
      },
    };
    const messageRepo = { getDisplayMessages: jest.fn().mockReturnValue([]) };

    await contextManager.processMessageContext(
      {} as App,
      message,
      {} as never,
      vault,
      ChainType.LLM_CHAIN,
      false,
      null,
      messageRepo as never
    );

    expect(mockProcessContextNotes).toHaveBeenCalledTimes(2);
    expect(mockProcessContextNotes.mock.calls[0][3]).toEqual([selectedNote]);
    expect(mockProcessContextNotes.mock.calls[1][3]).toEqual([folderNote]);
    expect(mockProcessContextNotes.mock.calls[1][3]).not.toContain(siblingNote);
    expect(mockGetSettings).toHaveBeenCalled();
  });
});
