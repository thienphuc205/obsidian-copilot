import { AgentModeChat } from "@/agentMode/ui/AgentModeChat";
import { ChatViewEventTarget, EventTargetContext } from "@/context";
import type CopilotPlugin from "@/main";
import { mountPluginViewRoot, type PluginViewRootHandle } from "@/utils/react/mountPluginViewRoot";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Modal } from "obsidian";
import * as React from "react";

/**
 * Frame class for the floating popup's native modal element; the sizing and
 * padding rules live in `src/styles/tailwind.css` (the source of the generated
 * `styles.css`), following the `.copilot-modal-full-bleed` precedent.
 */
export const FLOATING_AGENT_CHAT_MODAL_CLASS = "copilot-floating-agent-chat-modal";

interface FloatingAgentChatOptions {
  /**
   * Prompt seeded into the composer when the popup opens. Routed through the
   * chat bus's latched insert-text queue, so delivery no longer depends on
   * mount timing: the tree drains the latch whenever it attaches.
   */
  prefillPrompt?: string;
}

/**
 * Raycast-style floating popup that hosts the Agent Mode chat from anywhere in
 * the app, without opening the sidebar. It renders the SAME React tree as the
 * `CopilotAgentView` sidebar pane (EventTargetContext + Tooltip.Provider +
 * `AgentModeChat`), minus the leaf-specific bridges a sidebar pane needs
 * (layout observers, active-leaf routing).
 *
 * The popup deliberately shares the sidebar's session pool: `AgentModeChat`
 * talks to the plugin's shared `AgentSessionManager`
 * (`plugin.agentSessionManager`), so opening the popup never spawns a second
 * parallel session — it is the same chat, just floating. The modal owns no
 * session state of its own and its boundary ends at hosting the tree.
 */
export class FloatingAgentChatModal extends Modal {
  private viewRoot: PluginViewRootHandle | null = null;
  /**
   * Per-instance chat bus — the modal's counterpart of CopilotAgentView's
   * `eventTarget`. Fresh per instance so a latched prefill can never leak
   * into the sidebar view's bus or a previously-opened popup.
   */
  private readonly eventTarget = new ChatViewEventTarget();
  private readonly prefillPrompt: string | undefined;

  /**
   * @param plugin - The plugin instance owning the shared AgentSessionManager the chat tree runs against.
   * @param options - Popup configuration; `prefillPrompt` seeds the composer (see {@link FloatingAgentChatOptions.prefillPrompt}).
   */
  constructor(
    private plugin: CopilotPlugin,
    options: FloatingAgentChatOptions = {}
  ) {
    super(plugin.app);
    this.prefillPrompt = options.prefillPrompt;
  }

  onOpen(): void {
    this.modalEl.addClass(FLOATING_AGENT_CHAT_MODAL_CLASS);
    const { contentEl } = this;
    contentEl.empty();
    // `mountPluginViewRoot` renders into `containerEl.children[1]` — the
    // ItemView convention ([0] header slot, [1] content pane). A Modal's
    // contentEl starts empty and Obsidian's internal modal child order is not
    // a public contract, so provide that two-slot shape explicitly: [0] is an
    // inert anchor (display: none in the modal CSS), [1] hosts the tree and
    // stretches with the frame.
    contentEl.createDiv("copilot-floating-agent-chat-anchor");
    contentEl.createDiv("copilot-floating-agent-chat-host");
    // Latch the prefill BEFORE mounting: the bus holds it until the tree's
    // listener attaches, so the composer is seeded whether the chat surface
    // mounts immediately or after a session lands (cold start).
    if (this.prefillPrompt) {
      this.eventTarget.queueInsertText(this.prefillPrompt);
    }
    // Modal opens focused by Obsidian; latch the visibility request so the
    // composer takes keyboard focus once the tree mounts — the same seam
    // `activateAgentView` uses for the sidebar view.
    this.eventTarget.queueVisible();
    this.viewRoot = mountPluginViewRoot(contentEl, this.app, () => this.renderTree());
  }

  /** Same tree as CopilotAgentView.renderTree(), minus the leaf bridges. */
  private renderTree(): React.ReactNode {
    return (
      <EventTargetContext.Provider value={this.eventTarget}>
        <Tooltip.Provider delayDuration={0}>
          <AgentModeChat
            plugin={this.plugin}
            // No-op: the floating popup is not a workspace leaf, and the
            // autosave bridge walks CHAT_AGENT_VIEWTYPE leaves only, so there
            // is nothing for it to save here. The composer's manual Save
            // button saves through the session manager directly.
            onSaveChat={() => {}}
            updateUserMessageHistory={(msg) => this.plugin.updateUserMessageHistory(msg)}
          />
        </Tooltip.Provider>
      </EventTargetContext.Provider>
    );
  }

  onClose(): void {
    // PluginViewRootHandle.unmount detaches the window-migration listener and
    // unmounts the React root, so the chat tree (and its manager subscription)
    // tears down with the modal. The shared session keeps running; it lives in
    // the plugin's AgentSessionManager, not in this modal.
    this.viewRoot?.unmount();
    this.viewRoot = null;
  }
}
