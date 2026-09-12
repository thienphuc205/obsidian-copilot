import { createAgentSessionManager } from "./index";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

type SettingsShape = {
  enableAgentWebTools?: boolean;
  agentWebSearchProvider?: "firecrawl" | "tavily" | "exa" | "custom";
  firecrawlAgentWebApiKey?: string;
  tavilyAgentWebApiKey?: string;
  exaAgentWebApiKey?: string;
  customAgentWebApiKey?: string;
  customAgentWebBaseUrl?: string;
  agentMode?: { backends?: Record<string, unknown> };
};

const mockSettingsCallbacks = new Set<(prev: SettingsShape, next: SettingsShape) => void>();
const mockRestartBackend = jest.fn().mockResolvedValue(true);
const mockManager = {
  restartBackend: mockRestartBackend,
  preloadModels: jest.fn(() => Promise.resolve()),
  registerPreload: jest.fn(),
};
const mockSkillManager = {
  refresh: jest.fn(() => Promise.resolve()),
  subscribeToSkillSetChange: jest.fn(() => () => {}),
};

jest.mock("@/logger", () => ({
  logError: jest.fn(),
}));

jest.mock("@/settings/model", () => ({
  getSettings: () => ({ agentMode: { backends: {} } }),
  subscribeToSettingsChange: (callback: (prev: SettingsShape, next: SettingsShape) => void) => {
    mockSettingsCallbacks.add(callback);
    return () => mockSettingsCallbacks.delete(callback);
  },
}));

jest.mock("@/settings/copilotFolder", () => ({
  deriveSkillsFolder: () => "copilot/skills",
  getEffectiveSkillsFolder: () => "copilot/skills",
}));

jest.mock("@/system-prompts/state", () => ({
  subscribeToSystemPromptChange: () => () => {},
}));

jest.mock("@/utils/appPaths", () => ({
  copilotAppDataDir: () => "/tmp/obsidian-copilot-index-test",
  getVaultId: () => "fixture-vault",
}));

jest.mock("@/utils/desktopRuntime", () => ({
  requireNodeModule: (name: string) => (name === "os" ? nodeOs : nodePath),
}));

jest.mock("./backends/registry", () => ({
  backendRegistry: {},
  backendDisplayOrder: [],
  backendNeedsSelfHostWarning: () => false,
  getActiveBackendDescriptor: () => undefined,
  getCloudAgentIds: () => [],
  listBackendDescriptors: () => [],
  RECOMMENDED_BACKEND_ID: "codex",
}));

jest.mock("./backends/shared/agentSystemPrompt", () => ({
  buildAgentSystemPrompt: () => "fixture prompt",
}));

jest.mock("./backends/shared/builtinSkillEnv", () => ({
  getBuiltinSkillEnvRestartPolicy: () => "none",
}));

jest.mock("./session/AgentChatPersistenceManager", () => ({
  AgentChatPersistenceManager: class {},
}));

jest.mock("./session/AgentModelPreloader", () => ({
  AgentModelPreloader: class {},
}));

jest.mock("./session/AgentSessionIndex", () => ({
  AgentSessionIndex: class {
    constructor(..._args: unknown[]) {}
  },
}));

jest.mock("./session/nodeFileStorage", () => ({
  createNodeFileStorage: () => ({}),
}));

jest.mock("./session/AgentSessionManager", () => ({
  AgentSessionManager: function MockAgentSessionManager() {
    return mockManager;
  },
}));

jest.mock("./skills", () => ({
  SkillManager: {
    initialize: () => mockSkillManager,
  },
  getManagedSkills: () => [],
  useManagedSkills: () => [],
}));

jest.mock("./skills/builtin/builtinSkills", () => ({
  planManagedBuiltins: () => ({ seed: [], prune: [] }),
}));

jest.mock("./skills/builtin/seedBuiltinSkills", () => ({
  removeSeededBuiltin: () => Promise.resolve(),
  seedBuiltinSkills: () => Promise.resolve(),
}));

jest.mock("./skills/builtin/miyoSearchSeed", () => ({
  buildBuiltinSeedFs: () => ({}),
  installMiyoSearchSkill: jest.fn(),
  removeMiyoSearchSkill: jest.fn(),
}));

jest.mock("./ui/permissionPrompter", () => ({
  createDefaultAskUserQuestionPrompter: () => jest.fn(),
  createDefaultPermissionPrompter: () => jest.fn(),
}));

jest.mock("./ui/AgentModeChat", () => ({ AgentModeChat: function AgentModeChat() {} }));
jest.mock("./ui/CopilotAgentView", () => ({ default: function CopilotAgentView() {} }));
jest.mock("./ui/useBackendDescriptor", () => ({
  useActiveBackendDescriptor: jest.fn(),
  useBackendInstallState: jest.fn(),
  useManagedInstallActionState: jest.fn(),
  useSessionBackendDescriptor: jest.fn(),
}));
jest.mock("./ui/useAgentModelPicker", () => ({ useAgentModelPicker: jest.fn() }));
jest.mock("./ui/useAgentModePicker", () => ({ useAgentModePicker: jest.fn() }));
jest.mock("./ui/AgentDefaultModelSetting", () => ({ AgentDefaultModelSetting: function () {} }));
jest.mock("./ui/ModelEnableList", () => ({ ModelEnableList: function () {} }));
jest.mock("./ui/PlanPreviewView", () => ({
  PlanPreviewView: function PlanPreviewView() {},
  PLAN_PREVIEW_VIEW_TYPE: "fixture-plan-preview",
}));
jest.mock("./ui/ReportIssueModal", () => ({ ReportIssueModal: function () {} }));
jest.mock("./backends/opencode/opencodeProbePartition", () => ({
  partitionOpencodeOnlyWireIds: jest.fn(),
}));
jest.mock("./backends/opencode/opencodeModelResolve", () => ({
  mapProviderToOpencodeId: jest.fn(),
}));
jest.mock("@/lib/opencodeZenWireId", () => ({
  isOpencodeZenWireId: jest.fn(),
}));
jest.mock("./session/debugSink", () => ({
  frameSink: { append: jest.fn() },
  setFrameSinkVaultBasePath: jest.fn(),
}));
jest.mock("./backends/shared/ui/AgentBackendHeader", () => ({
  AgentBackendHeader: function () {},
}));
jest.mock("./session/useBackendAuthState", () => ({ useBackendAuthState: jest.fn() }));

function emitSettingsChange(prev: SettingsShape, next: SettingsShape): void {
  for (const callback of mockSettingsCallbacks) callback(prev, next);
}

function buildPlugin(): unknown {
  return {
    manifest: { version: "fixture" },
    modelManagement: {
      providerRegistry: { subscribe: jest.fn(() => () => {}) },
      backendConfigRegistry: { subscribe: jest.fn(() => () => {}) },
    },
  };
}

describe("Agent Mode web settings restart wiring", () => {
  beforeEach(() => {
    mockSettingsCallbacks.clear();
    mockRestartBackend.mockClear();
  });

  it("immediately restarts Codex when independent web capability settings change", async () => {
    createAgentSessionManager({} as never, buildPlugin() as never);

    emitSettingsChange(
      {
        enableAgentWebTools: false,
        agentWebSearchProvider: "firecrawl",
        firecrawlAgentWebApiKey: "old-key",
        agentMode: { backends: {} },
      },
      {
        enableAgentWebTools: true,
        agentWebSearchProvider: "firecrawl",
        firecrawlAgentWebApiKey: "new-key",
        agentMode: { backends: {} },
      }
    );
    await Promise.resolve();

    expect(mockRestartBackend).toHaveBeenCalledWith(
      "codex",
      "independent Agent web tools changed",
      { deferWhileBusy: false }
    );
  });

  it.each(["exaAgentWebApiKey", "customAgentWebApiKey", "customAgentWebBaseUrl"] as const)(
    "restarts Codex immediately when %s changes",
    async (key) => {
      createAgentSessionManager({} as never, buildPlugin() as never);
      const prev: SettingsShape = { agentMode: { backends: {} }, [key]: "old" };
      emitSettingsChange(prev, { ...prev, [key]: "new" });
      await Promise.resolve();
      expect(mockRestartBackend).toHaveBeenCalledWith(
        "codex",
        "independent Agent web tools changed",
        { deferWhileBusy: false }
      );
    }
  );

  it("does not restart when the independent web settings are unchanged", async () => {
    createAgentSessionManager({} as never, buildPlugin() as never);
    const settings = {
      enableAgentWebTools: true,
      agentWebSearchProvider: "firecrawl" as const,
      firecrawlAgentWebApiKey: "same-key",
      agentMode: { backends: {} },
    };

    emitSettingsChange(settings, { ...settings, agentMode: { backends: {} } });
    await Promise.resolve();

    expect(mockRestartBackend).not.toHaveBeenCalled();
  });

  it("immediately restarts Codex when the Tavily key is rotated", async () => {
    createAgentSessionManager({} as never, buildPlugin() as never);
    const prev: SettingsShape = {
      enableAgentWebTools: true,
      agentWebSearchProvider: "tavily",
      tavilyAgentWebApiKey: "old-key",
      agentMode: { backends: {} },
    };
    emitSettingsChange(prev, { ...prev, tavilyAgentWebApiKey: "new-key" });
    await Promise.resolve();
    expect(mockRestartBackend).toHaveBeenCalledWith(
      "codex",
      "independent Agent web tools changed",
      { deferWhileBusy: false }
    );
  });
});
