import { QuickAskPanel } from "@/components/quick-ask/QuickAskPanel";
import type { QuickAskMessage } from "@/components/quick-ask/types";
import type { AgentSessionManager } from "@/agentMode/session/AgentSessionManager";
import type CopilotPlugin from "@/main";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Editor } from "obsidian";
import type { EditorView } from "@codemirror/view";
import React from "react";

// The panel's session pipelines are replaced with controllable stubs; the
// toggle behavior under test is which pipeline the panel wires and how the
// toggle's own state renders, not the pipelines' internals.
const mockSessionApi = {
  messages: [] as QuickAskMessage[],
  isStreaming: false,
  sendMessage: jest.fn(async () => undefined),
  stop: jest.fn(),
  clear: jest.fn(),
};

let lastAgentModeValue: boolean | undefined;

// Mock factory names must match the real `use*` exports, so the no-hook
// `use` prefix is expected here (mirrors AgentModeChat.test.tsx).
/* eslint-disable @eslint-react/hooks-extra/no-unnecessary-use-prefix */
jest.mock("./useQuickAskSession", () => ({
  useQuickAskSession: (params: { agentMode: boolean }) => {
    lastAgentModeValue = params.agentMode;
    return mockSessionApi;
  },
}));

// Heavy children are irrelevant to the toggle behavior — stub them out.
jest.mock("@/components/ui/ModelSelector", () => ({
  ModelSelector: () => <div data-testid="model-selector" />,
}));
jest.mock("@/components/chat-components/useChatModelPicker", () => ({
  useChatModelPicker: () => ({ value: "", models: [], onChange: jest.fn() }),
}));
jest.mock("./QuickAskInput", () => ({
  QuickAskInput: () => <div data-testid="quick-ask-input" />,
}));
jest.mock("./QuickAskMessage", () => ({
  QuickAskMessageComponent: ({ message }: { message: QuickAskMessage }) => (
    <div data-testid="quick-ask-message">{message.content}</div>
  ),
}));
jest.mock("@/hooks/use-draggable", () => ({
  useDraggable: () => ({ handleMouseDown: jest.fn() }),
}));
/* eslint-enable @eslint-react/hooks-extra/no-unnecessary-use-prefix */

const replaceGuard = {
  getRange: jest.fn(() => null),
  validate: jest.fn(),
  replace: jest.fn(),
};

function makePlugin(): CopilotPlugin {
  return {
    app: {
      workspace: { getActiveFile: jest.fn(() => null) },
    },
    agentSessionManager: {} as unknown as AgentSessionManager,
  } as unknown as CopilotPlugin;
}

function renderPanel() {
  const plugin = makePlugin();
  return render(
    <QuickAskPanel
      plugin={plugin}
      editor={{} as Editor}
      view={{} as EditorView}
      selectedText="selection"
      replaceGuard={replaceGuard as unknown as Parameters<typeof QuickAskPanel>[0]["replaceGuard"]}
      onClose={jest.fn()}
    />
  );
}

const AGENT_TOGGLE_TITLE = "Agent mode — uses the active agent backend with full skills";

describe("QuickAskPanel", () => {
  beforeEach(() => {
    mockSessionApi.messages = [];
    mockSessionApi.isStreaming = false;
    mockSessionApi.sendMessage.mockClear();
    mockSessionApi.stop.mockClear();
    mockSessionApi.clear.mockClear();
    lastAgentModeValue = undefined;
  });

  describe("Agent mode toggle", () => {
    it("renders the header toggle, defaulting to OFF", () => {
      renderPanel();

      const toggle = screen.getByTitle(AGENT_TOGGLE_TITLE);
      expect(toggle).toBeTruthy();
      expect((toggle as HTMLButtonElement).disabled).toBe(false);
      expect(lastAgentModeValue).toBe(false);
    });

    it("toggles state on click and persists per open (component state)", () => {
      const { unmount } = renderPanel();

      const toggle = screen.getByTitle(AGENT_TOGGLE_TITLE);
      fireEvent.click(toggle);
      expect(lastAgentModeValue).toBe(true);

      // Persist per open: still on across re-renders within this mount.
      fireEvent.click(toggle);
      expect(lastAgentModeValue).toBe(false);

      unmount();
      // A fresh open defaults to OFF again.
      renderPanel();
      expect(lastAgentModeValue).toBe(false);
    });

    it("disables the toggle while a turn is streaming", () => {
      mockSessionApi.isStreaming = true;
      renderPanel();

      const toggle: HTMLButtonElement | null = screen
        .getByTitle(AGENT_TOGGLE_TITLE)
        .closest("button");
      expect(toggle?.disabled).toBe(true);
    });

    it("keeps the toggle enabled when idle", () => {
      renderPanel();

      const toggle: HTMLButtonElement | null = screen
        .getByTitle(AGENT_TOGGLE_TITLE)
        .closest("button");
      expect(toggle?.disabled).toBe(false);
    });
  });

  describe("Quick Chat mode (toggle OFF)", () => {
    it("wires the Quick Chat pipeline with the original params", () => {
      renderPanel();

      expect(lastAgentModeValue).toBe(false);
      // Idle idle state: the send button is present, the stop button is not —
      // the unchanged Quick Chat toolbar contract.
      expect(screen.queryByTitle("Stop generating")).toBeNull();
      expect(screen.getByTitle("Send message")).toBeTruthy();
    });
  });
});
