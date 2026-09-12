/**
 * useQuickAskAgentTurn - Agent-backed turn pipeline for the Quick Ask panel.
 *
 * When Agent mode is toggled on, `sendMessage` routes the composed turn prompt
 * through the ACTIVE agent session (`plugin.agentSessionManager.getActiveSession()`)
 * — the exact same session the sidebar and floating popup use, so skills and
 * tools are available to the anchored near-selection panel. No session is ever
 * spawned here: with no active session the hook fails closed with an error
 * message telling the user to open Agent Chat once.
 *
 * Turn text (reasoning + prose) accumulates into one transient assistant
 * message; tool activity renders as a single compact status line. The shared
 * session's own store still holds the canonical transcript — the panel keeps a
 * private projection so its message list stays independent of the sidebar's.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Notice } from "obsidian";

import { USER_SENDER } from "@/constants";
import { logError } from "@/logger";
import type CopilotPlugin from "@/main";
import type { QuickAskMessage } from "./types";

interface UseQuickAskAgentTurnParams {
  plugin: CopilotPlugin;
  selectedText: string;
}

interface QuickAskAgentTurnApi {
  messages: QuickAskMessage[];
  isStreaming: boolean;
  sendMessage: (input: string) => Promise<void>;
  stop: () => void;
  clear: () => void;
}

/**
 * Structural views of the agent-session surface this hook consumes. Declared
 * locally (instead of importing from `@/agentMode/session/*`) to respect the
 * host→session boundary fence; `AgentSessionManager` and `AgentSession` are
 * structurally compatible, so the plugin's real objects satisfy them.
 */
interface AgentTurnMessagePart {
  kind: string;
  text?: string;
  title?: string;
}

interface AgentTurnTranscriptMessage {
  id: string;
  sender: string;
  parts?: AgentTurnMessagePart[];
}

interface AgentTurnSession {
  getStatus(): string;
  sendPrompt(displayText: string): { turn: Promise<unknown>; userMessageId: string };
  cancel(): Promise<void>;
  store: {
    getDisplayMessages(): AgentTurnTranscriptMessage[];
  };
}

interface AgentTurnSessionManager {
  getActiveSession(): AgentTurnSession | null;
  subscribe(listener: () => void): () => void;
}

/** Frozen empty message list — referential stability (see AGENTS.md). */
const EMPTY_MESSAGES: readonly QuickAskMessage[] = Object.freeze([]);

const NO_SESSION_ERROR =
  "No active agent session. Open Agent Chat once to start a session, then try Agent mode again.";

const NO_SESSION_NOTICE = "No active agent session. Open Agent Chat once to start a session.";

/**
 * Fold a turn's structured parts into the panel's flat rendering model:
 * reasoning + prose concatenated in stream order (reasoning joined as plain
 * text), one blank line between blocks. Tool_call parts are intentionally not
 * folded into the text — they surface as the compact status line instead.
 */
function projectTurnText(parts: readonly AgentTurnMessagePart[]): string {
  const blocks: string[] = [];
  for (const part of parts) {
    if ((part.kind === "thought" || part.kind === "text") && part.text?.trim()) {
      blocks.push(part.text.trim());
    }
  }
  return blocks.join("\n\n");
}

/** Latest tool-call title in stream order, for the compact status line. */
function latestToolLabel(parts: readonly AgentTurnMessagePart[]): string | null {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.kind === "tool_call") return part.title || "tool";
  }
  return null;
}

/**
 * Agent-backed turn pipeline for Quick Ask's Agent mode. Reads the ACTIVE
 * session on each send (the manager's active pointer can move between sends);
 * streams the turn's text parts into a live assistant message, surfaces tool
 * activity as a compact status line, and appends the panel's error message on
 * failure. Concurrency is gated on `isStreaming` — one turn at a time.
 */
export function useQuickAskAgentTurn(params: UseQuickAskAgentTurnParams): QuickAskAgentTurnApi {
  const { plugin, selectedText } = params;

  const [messages, setMessages] = useState<QuickAskMessage[]>(EMPTY_MESSAGES as QuickAskMessage[]);
  const [isStreaming, setIsStreaming] = useState(false);

  // Reason: prevent setState after the panel unmounts mid-turn.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Authoritative re-entrancy gate: state can lag within a render batch, so
  // same-tick double sends must be caught by the ref too.
  const isStreamingRef = useRef(false);

  // Live subscription handle for the in-flight turn's session. Kept in refs so
  // `stop` and unmount cleanup can reach it without re-creating sendMessage.
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // The session the in-flight turn runs on. The manager's active pointer can
  // move mid-turn (tab switches), so Stop must target the turn's own session.
  const turnSessionRef = useRef<AgentTurnSession | null>(null);

  const releaseSubscription = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    turnSessionRef.current = null;
  }, []);

  useEffect(() => releaseSubscription, [releaseSubscription]);

  const stop = useCallback(() => {
    const session = turnSessionRef.current ?? plugin.agentSessionManager?.getActiveSession();
    if (!session) return;
    void session.cancel().catch((e) => {
      logError("[QuickAsk] agent cancel failed", e);
      new Notice("Failed to stop the agent. Please try again.");
    });
  }, [plugin]);

  const clear = useCallback(() => {
    setMessages(EMPTY_MESSAGES as QuickAskMessage[]);
  }, []);

  const sendMessage = useCallback(
    async (input: string) => {
      if (!input.trim() || isStreamingRef.current) return;
      isStreamingRef.current = true;

      const manager: AgentTurnSessionManager | undefined = plugin.agentSessionManager;
      const session = manager?.getActiveSession();
      if (!manager || !session) {
        // Fail closed — never auto-spawn sessions from Quick Ask.
        isStreamingRef.current = false;
        setMessages((prev) => [
          ...prev,
          {
            id: `qa-agent-error-${Date.now()}`,
            role: "assistant",
            content: NO_SESSION_ERROR,
            timestamp: Date.now(),
            isError: true,
          },
        ]);
        new Notice(NO_SESSION_NOTICE);
        return;
      }

      // The shared session may already be running a turn from the sidebar or
      // floating popup; its sendPrompt throws on overlap, so pre-gate here.
      const status = session.getStatus();
      if (status === "running" || status === "awaiting_permission") {
        isStreamingRef.current = false;
        new Notice("The agent session is busy. Wait for the current turn to finish.");
        return;
      }
      if (status === "starting" || status === "closed") {
        isStreamingRef.current = false;
        new Notice("The agent session is not ready. Try again in a moment.");
        return;
      }

      const userMessage: QuickAskMessage = {
        id: `qa-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: "user",
        content: input,
        timestamp: Date.now(),
      };
      const assistantId = `qa-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const assistantMessage: QuickAskMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setIsStreaming(true);

      // The session's placeholder assistant message (created synchronously by
      // sendPrompt) carries the turn's structured parts. Capture its id after
      // the send starts; parts that already existed are pre-turn activity.
      let placeholderId: string | null = null;
      let baselinePartCount = 0;
      let sawFirstNotification = false;

      unsubscribeRef.current = manager.subscribe(() => {
        if (!isMountedRef.current) return;
        const transcript = session.store.getDisplayMessages();
        if (!sawFirstNotification) {
          // First tick after the send: locate the fresh placeholder at the
          // transcript tail (sendPrompt appends user + placeholder in order).
          const tail = transcript[transcript.length - 1];
          if (tail && tail.sender !== USER_SENDER) {
            placeholderId = tail.id;
            baselinePartCount = tail.parts?.length ?? 0;
          }
          sawFirstNotification = true;
          return;
        }
        if (!placeholderId) return;
        const placeholder = transcript.find((m) => m.id === placeholderId);
        const parts = placeholder?.parts ?? [];
        const turnParts = parts.slice(baselinePartCount);
        const text = projectTurnText(turnParts);
        const toolLabel = latestToolLabel(turnParts);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: text,
                  ...(toolLabel ? { toolStatusLabel: `Working: ${toolLabel}` } : {}),
                }
              : m
          )
        );
      });

      const turnPrompt = `Selected text:\n${selectedText}\n\nQuestion: ${input}`;

      turnSessionRef.current = session;
      let failure: unknown = null;
      try {
        await session.sendPrompt(turnPrompt).turn;
      } catch (err) {
        failure = err;
        logError("[QuickAsk] agent turn failed", err);
      }

      releaseSubscription();
      isStreamingRef.current = false;
      if (!isMountedRef.current) return;

      setIsStreaming(false);
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId) return m;
          if (failure !== null) {
            const detail = errToString(failure);
            const body = m.content
              ? `${m.content}\n\n**Error:** ${detail}`
              : `**Error:** ${detail}`;
            return { ...m, content: body, isError: true, toolStatusLabel: undefined };
          }
          // Keep the final streamed state; drop the transient tool line.
          return { ...m, toolStatusLabel: undefined };
        })
      );
      if (failure !== null) {
        new Notice("Error generating response. Please try again.");
      }
    },
    [plugin, releaseSubscription, selectedText]
  );

  return { messages, isStreaming, sendMessage, stop, clear };
}

/** Human-readable failure text without object-stringification surprises. */
function errToString(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "The agent turn failed.";
}
