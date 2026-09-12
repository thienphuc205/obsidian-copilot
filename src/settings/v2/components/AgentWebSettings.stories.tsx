import type { Meta, StoryObj } from "@/lib/story";
import type { WebProvider } from "@/web/types";
import {
  AgentWebSettings,
  type AgentWebProviderFactory,
  type AgentWebSettingsProps,
} from "./AgentWebSettings";

const noop = (): void => undefined;

const previewProvider: WebProvider = {
  search: async () => ({
    kind: "web_search",
    content: "",
    sources: [],
    citations: [],
  }),
  fetch: async (url) => ({
    kind: "web_fetch",
    url,
    content: "",
    sources: [],
    citations: [],
    truncated: false,
  }),
  testConnection: async () => undefined,
};

const previewFactory: AgentWebProviderFactory = () => previewProvider;

const meta = {
  title: "Settings/Codex Agent Web Tools",
  component: AgentWebSettings,
  args: {
    enabled: false,
    provider: "firecrawl",
    apiKey: "",
    baseUrl: "",
    onBaseUrlChange: noop,
    onEnabledChange: noop,
    onProviderChange: noop,
    onApiKeyChange: noop,
    providerFactory: previewFactory,
  },
  parameters: { gallery: { host: "settings-tab", layout: "padded" } },
} satisfies Meta<AgentWebSettingsProps>;
export default meta;

export const Disabled: StoryObj<AgentWebSettingsProps> = {};

export const DisabledWithKey: StoryObj<AgentWebSettingsProps> = {
  args: { apiKey: "fc-preview-key" },
};

export const EnabledWithoutKey: StoryObj<AgentWebSettingsProps> = {
  args: { enabled: true },
};

export const EnabledWithKey: StoryObj<AgentWebSettingsProps> = {
  args: { enabled: true, apiKey: "fc-preview-key" },
};

export const Checking: StoryObj<AgentWebSettingsProps> = {
  args: {
    enabled: true,
    apiKey: "fc-preview-key",
    initialConnectionStatus: "checking",
  },
};

export const ConnectionSuccess: StoryObj<AgentWebSettingsProps> = {
  args: {
    enabled: true,
    apiKey: "fc-preview-key",
    initialConnectionStatus: "success",
  },
};

export const ConnectionError: StoryObj<AgentWebSettingsProps> = {
  args: {
    enabled: true,
    apiKey: "fc-preview-key",
    initialConnectionStatus: "error",
  },
};

export const TavilyWithKey: StoryObj<AgentWebSettingsProps> = {
  args: { enabled: true, provider: "tavily", apiKey: "tvly-preview-key" },
};

export const TavilyConnectionError: StoryObj<AgentWebSettingsProps> = {
  args: {
    enabled: true,
    provider: "tavily",
    apiKey: "tvly-preview-key",
    initialConnectionStatus: "error",
  },
};

export const ExaWithKey: StoryObj<AgentWebSettingsProps> = {
  args: { enabled: true, provider: "exa", apiKey: "exa-preview-key" },
};
export const CustomWithoutUrl: StoryObj<AgentWebSettingsProps> = {
  args: { enabled: true, provider: "custom", apiKey: "custom-preview-key" },
};
export const CustomWithKey: StoryObj<AgentWebSettingsProps> = {
  args: {
    enabled: true,
    provider: "custom",
    apiKey: "custom-preview-key",
    baseUrl: "https://search.example.com/api",
  },
};
