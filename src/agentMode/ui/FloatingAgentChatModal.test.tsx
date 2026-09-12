import { FloatingAgentChatModal } from "@/agentMode/ui/FloatingAgentChatModal";
import { ChatViewEventTarget, EventTargetContext } from "@/context";
import type CopilotPlugin from "@/main";
import { act, within } from "@testing-library/react";
import React from "react";

interface ModalMockWithMigration {
  migratedCallbacks: Array<() => void>;
}

// Buses and drained prefill texts the mounted chat trees observed, recorded by
// the probe so the suite can assert delivery and per-popup isolation without
// state inside the probe.
const mockDeliveredBuses: EventTarget[] = [];
const mockDrainedPrefills: string[] = [];

jest.mock("obsidian", () => ({
  App: class App {},
  Modal: class Modal {
    app: unknown;
    containerEl = activeDocument.createElement("div");
    modalEl = activeDocument.createElement("div");
    titleEl = activeDocument.createElement("div");
    contentEl = activeDocument.createElement("div");
    migratedCallbacks: Array<() => void> = [];
    onClose?: () => void;

    constructor(app: unknown) {
      this.app = app;
      // Polyfill the Obsidian DOM helpers the modal under test reaches for;
      // jest.setup.js covers createEl/addClass but neither `empty()` nor the
      // `onWindowMigrated` mountPluginViewRoot binds to.
      this.contentEl.empty = () => {
        this.contentEl.replaceChildren();
      };
      (
        this.contentEl as unknown as Record<
          "onWindowMigrated",
          (callback: () => void) => () => void
        >
      ).onWindowMigrated = (callback: () => void) => {
        this.migratedCallbacks.push(callback);
        return () => {
          this.migratedCallbacks = this.migratedCallbacks.filter((cb) => cb !== callback);
        };
      };
    }

    close(): void {
      this.onClose?.();
    }
  },
}));

// The shared-session contract the popup relies on is that it mounts the same
// AgentModeChat tree as the sidebar view; the real tree's internals belong to
// AgentModeChat's own suite. This stand-in renders the mount marker plus a
// probe that drains the insert-text latch exactly the way AgentHome does on
// attach — the delivery contract the modal must satisfy for a composer
// prefill to reach the real chat. The probe records what it drained instead of
// re-rendering state, so assertions read the recorded arrays.
function ProbeAgentModeChat(): React.ReactElement {
  const { ChatViewEventTarget: Bus } = jest.requireActual<typeof import("@/context")>("@/context");
  const eventTarget = React.useContext(EventTargetContext);
  const bus = eventTarget instanceof Bus ? eventTarget : null;
  React.useEffect(() => {
    mockDeliveredBuses.push(eventTarget as EventTarget);
    const pending = bus?.consumePendingInsertText();
    if (typeof pending === "string") mockDrainedPrefills.push(pending);
  }, [bus, eventTarget]);
  return <div data-testid="agent-chat" />;
}

jest.mock("@/agentMode/ui/AgentModeChat", () => ({
  AgentModeChat: ProbeAgentModeChat,
}));

function makePlugin(): CopilotPlugin {
  return {
    app: {},
    agentSessionManager: {},
    updateUserMessageHistory: jest.fn(),
  } as unknown as CopilotPlugin;
}

const openModals: FloatingAgentChatModal[] = [];

function openModal(options?: { prefillPrompt?: string }): FloatingAgentChatModal {
  const modal = new FloatingAgentChatModal(makePlugin(), options);
  document.body.appendChild(modal.containerEl);
  act(() => {
    modal.onOpen();
  });
  openModals.push(modal);
  return modal;
}

describe("FloatingAgentChatModal", () => {
  afterEach(() => {
    for (const modal of openModals.splice(0)) {
      act(() => {
        modal.onClose();
      });
    }
    document.body.innerHTML = "";
    mockDeliveredBuses.length = 0;
    mockDrainedPrefills.length = 0;
    jest.restoreAllMocks();
  });

  describe("onOpen()", () => {
    it("marks the native modal frame with the floating-chat class for the popup styling", () => {
      const modal = openModal();

      expect(modal.modalEl.classList.contains("copilot-floating-agent-chat-modal")).toBe(true);
    });

    it("renders the shared agent chat tree exactly once into the modal content", () => {
      const modal = openModal();

      // One mount only: the popup shares the sidebar's AgentSessionManager
      // pool, so a second mount would mean a second chat surface.
      expect(modal.contentEl.querySelectorAll('[data-testid="agent-chat"]').length).toBe(1);
    });

    it("seeds the composer by latching the prefill prompt onto the bus the tree consumes on mount", () => {
      const queueSpy = jest.spyOn(ChatViewEventTarget.prototype, "queueInsertText");
      openModal({ prefillPrompt: "Read [[My Note]] and let's discuss it" });

      expect(queueSpy).toHaveBeenCalledWith("Read [[My Note]] and let's discuss it");
      // The probe drains the latch the same way AgentHome does on attach, so
      // the latched text is what the mounted tree receives.
      expect(mockDrainedPrefills).toEqual(["Read [[My Note]] and let's discuss it"]);
    });

    it("seeds nothing when no prefill prompt is given", () => {
      const queueSpy = jest.spyOn(ChatViewEventTarget.prototype, "queueInsertText");
      openModal();

      expect(queueSpy).not.toHaveBeenCalled();
      expect(mockDrainedPrefills).toEqual([]);
    });

    it("gives each popup a fresh ChatViewEventTarget so a latched prefill cannot cross popups", () => {
      openModal({ prefillPrompt: "Read [[First]] and let's discuss it" });
      openModal();

      // Each popup mounted its own bus, and only the prefilled one delivered
      // the latched text — the second popup's tree drained nothing.
      expect(mockDeliveredBuses).toHaveLength(2);
      expect(mockDeliveredBuses[0]).not.toBe(mockDeliveredBuses[1]);
      expect(mockDrainedPrefills).toEqual(["Read [[First]] and let's discuss it"]);
    });
  });

  describe("onClose()", () => {
    it("unmounts the React root and detaches the window-migration listener", () => {
      const modal = openModal();
      expect(within(modal.contentEl).getByTestId("agent-chat")).toBeTruthy();

      act(() => {
        modal.onClose();
      });

      expect(modal.contentEl.querySelector('[data-testid="agent-chat"]')).toBeNull();
      expect((modal as unknown as ModalMockWithMigration).migratedCallbacks).toHaveLength(0);
    });
  });
});
