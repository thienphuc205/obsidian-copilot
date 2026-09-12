/**
 * useQuickAskSession - Custom hook for managing Quick Ask chat session.
 * Handles conversation state and delegates streaming to shared hook.
 */

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Notice } from "obsidian";
import { v4 as uuidv4 } from "uuid";

import {
  useStreamingChatSession,
  type StreamingChatTurnContext,
} from "@/hooks/use-streaming-chat-session";
import {
  QUICK_COMMAND_SYSTEM_PROMPT,
  appendIncludeNoteContextPlaceholders,
} from "@/commands/quickCommandPrompts";
import { processCommandPrompt } from "@/commands/customCommandUtils";
import { useApp } from "@/context";
import { useResolvedChatBackendModel } from "@/hooks/useResolvedChatBackendModel";
import { logError } from "@/logger";
import type CopilotPlugin from "@/main";
import type { QuickAskMessage } from "./types";
import { useQuickAskAgentTurn } from "./useQuickAskAgentTurn";

interface UseQuickAskSessionParams {
  plugin: CopilotPlugin;
  selectedText: string;
  /** Selected model — a `configuredModelId` in the chat backend. */
  selectedModelKey: string;
  includeNoteContext: boolean;
  /** When true, turns run through the active agent session instead of Quick Chat. */
  agentMode: boolean;
}

interface QuickAskSessionApi {
  messages: QuickAskMessage[];
  isStreaming: boolean;
  sendMessage: (inputText: string) => Promise<void>;
  stop: () => void;
  clear: () => void;
}

/**
 * Hook for managing Quick Ask session state and streaming.
 */
export function useQuickAskSession(params: UseQuickAskSessionParams): QuickAskSessionApi {
  const app = useApp();
  const { plugin, selectedText, selectedModelKey, includeNoteContext, agentMode } = params;

  // Agent-mode pipeline. Hooks stay unconditional so the toggle can flip modes
  // without remounting; the agent branch is only *used* when agentMode is on.
  const agentTurn = useQuickAskAgentTurn({ plugin, selectedText });

  // Message history (completed messages only)
  const [messages, setMessages] = useState<QuickAskMessage[]>([]);

  // Reason: Prevents setState calls after the component unmounts.
  // Without this guard, async operations (runTurn) that resolve after panel close
  // would trigger React warnings and potential state corruption.
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Resolve the selected chat-backend model (preferred id → first enabled → null).
  const resolvedModel = useResolvedChatBackendModel(app, selectedModelKey);

  // Use shared streaming hook
  const {
    isStreaming,
    streamingText,
    runTurn,
    stop: stopStreaming,
    reset,
  } = useStreamingChatSession({
    model: resolvedModel,
    systemPrompt: QUICK_COMMAND_SYSTEM_PROMPT,
    excludeThinking: true,
    onNoModel: () => {
      logError("No active model is configured. Please configure a model in Copilot settings.");
      new Notice("No active model configured. Please configure a model in Copilot settings.");
    },
    onNonAbortError: (error) => {
      logError("Error generating response:", error);
      new Notice("Error generating response. Please try again.");
    },
  });

  const sendMessage = useCallback(
    async (input: string) => {
      if (!input.trim()) return;

      // Add user message immediately for responsive UI
      // Reason: selectedText context is handled by the prompt processing pipeline,
      // so displayContent does not embed <selected_text> XML tags.
      const userMessage: QuickAskMessage = {
        id: uuidv4(),
        role: "user",
        content: input,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, userMessage]);

      // Run the streaming turn
      const result = await runTurn(async (ctx: StreamingChatTurnContext) => {
        // Apply first-turn transforms
        let processedInput = input;
        if (ctx.isFirstTurn) {
          processedInput = appendIncludeNoteContextPlaceholders(input, includeNoteContext);
        }

        // Check abort before async operation
        if (ctx.signal.aborted) return "";

        // Process prompt (follow-up messages skip appending selected text)
        const prompt = await processCommandPrompt(
          app,
          processedInput,
          selectedText,
          !ctx.isFirstTurn
        );

        return prompt;
      });

      // Reason: If the panel was closed/unmounted during the async runTurn,
      // skip all state updates to avoid orphan setState calls.
      if (!isMountedRef.current) {
        return;
      }

      if (result) {
        // Add assistant message on success
        const assistantMessage: QuickAskMessage = {
          id: uuidv4(),
          role: "assistant",
          content: result,
          timestamp: Date.now(),
        };
        setMessages((prev) => [...prev, assistantMessage]);
      } else {
        // Reason: If runTurn returns null, rollback the optimistically added
        // user message to avoid orphan messages. This covers:
        // - busy / re-entrancy (another turn in progress)
        // - no model configured
        // - empty prompt
        // - abort before streaming started
        // - reset() called (stale turn)
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.id === userMessage.id) {
            return prev.slice(0, -1);
          }
          return prev;
        });
      }
    },
    [app, includeNoteContext, runTurn, selectedText]
  );

  const stop = useCallback(() => {
    stopStreaming();
  }, [stopStreaming]);

  const clear = useCallback(() => {
    setMessages([]);
    reset();
  }, [reset]);

  // Compute display messages (include streaming content)
  const displayMessages = useMemo(() => {
    if (!isStreaming || !streamingText) return messages;
    return [
      ...messages,
      {
        id: "streaming",
        role: "assistant" as const,
        content: streamingText,
        timestamp: Date.now(),
      },
    ];
  }, [messages, isStreaming, streamingText]);

  // Reason: The agent branch must be a pure projection selected after all
  // hooks run, so flipping the toggle swaps pipelines without remounting and
  // the Quick Chat path (toggle OFF) stays byte-identical to before.
  if (agentMode) {
    return {
      messages: agentTurn.messages,
      isStreaming: agentTurn.isStreaming,
      sendMessage: agentTurn.sendMessage,
      stop: agentTurn.stop,
      clear: agentTurn.clear,
    };
  }

  return {
    messages: displayMessages,
    isStreaming,
    sendMessage,
    stop,
    clear,
  };
}
