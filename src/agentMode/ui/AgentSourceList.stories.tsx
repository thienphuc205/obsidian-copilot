import { AgentSourceList, type AgentSourceListProps } from "@/agentMode/ui/AgentSourceList";
import type { SourceReference } from "@/context/sourceReferences";
import type { Meta, StoryObj } from "@/lib/story";
import type { App } from "obsidian";

const app = {} as App;

function source(
  title: string,
  url: string,
  overrides: Partial<SourceReference> = {}
): SourceReference {
  return {
    title,
    path: url,
    score: 0,
    kind: "web",
    url,
    ...overrides,
  };
}

const meta = {
  title: "Agent Mode/Agent Source List",
  component: AgentSourceList,
  parameters: { gallery: { host: "leaf", layout: "padded" } },
} satisfies Meta<AgentSourceListProps>;
export default meta;

export const MultipleSources: StoryObj<AgentSourceListProps> = {
  args: {
    app,
    sources: [
      source("Obsidian Help", "https://help.obsidian.md/"),
      source("Agent Client Protocol", "https://agentclientprotocol.com/"),
      source("Web search reference", "https://example.com/research"),
    ],
  },
};

export const MixedSafeAndUnsafeSources: StoryObj<AgentSourceListProps> = {
  args: {
    app,
    sources: [
      source("Safe result", "https://example.com/safe"),
      source("Vault note", "Research/roadmap.md", { kind: "vault", url: undefined }),
      source("Unsafe script", "javascript:alert(1)"),
      source("Credential-bearing URL", "https://user:pass@example.com/private"),
      source("Another safe result", "https://example.com/another"),
    ],
  },
};
