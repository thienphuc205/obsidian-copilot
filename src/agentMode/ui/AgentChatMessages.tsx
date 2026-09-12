import { AgentTrail } from "@/agentMode/ui/AgentTrailView";
import { AskUserQuestionCard } from "@/agentMode/ui/AskUserQuestionCard";
import { FanoutMessageCard } from "@/agentMode/ui/FanoutMessageCard";
import { PlanProposalCard } from "@/agentMode/ui/PlanProposalCard";
import { ToolPermissionCard } from "@/agentMode/ui/ToolPermissionCard";
import { AgentTurnDurationIndicator } from "@/agentMode/ui/AgentTurnDurationIndicator";
import { AgentSourceList } from "@/agentMode/ui/AgentSourceList";
import ChatSingleMessage from "@/components/chat-components/ChatSingleMessage";
import { USER_SENDER } from "@/constants";
import { useChatScrolling } from "@/hooks/useChatScrolling";
import type { AgentChatBackend } from "@/agentMode/session/AgentChatBackend";
import type {
  AgentChatMessage,
  AgentMessagePart,
  AskUserQuestionPrompt,
  CurrentPlan,
  PermissionPrompt,
} from "@/agentMode/session/types";
import {
  deriveResearchProgress,
  isResearchRun,
  toResearchToolEvent,
} from "@/agentMode/ui/researchProgress";
import { openFileInWorkspace } from "@/utils";
import type { ChatMessage } from "@/types/message";
import { App, TFile } from "obsidian";
import React, { memo, useCallback, useMemo } from "react";

interface AgentChatMessagesProps {
  messages: AgentChatMessage[];
  app: App;
  currentPlan: CurrentPlan | null;
  pendingToolPermissions: PermissionPrompt[];
  pendingAskUserQuestions: AskUserQuestionPrompt[];
  chatBackend: AgentChatBackend;
  /** True while a turn is in flight. The last assistant message in the
   *  visible list is treated as the streaming placeholder. */
  isLoading: boolean;
}

/**
 * Maps an AgentChatMessage to the subset of ChatMessage fields that
 * `ChatSingleMessage` consumes. Lets us reuse the leaf message renderer
 * without coupling Agent Mode types to the legacy `ChatMessage` shape.
 */
function toChatMessageView(m: AgentChatMessage): ChatMessage {
  return {
    id: m.id,
    sender: m.sender,
    message: m.message,
    timestamp: m.timestamp,
    isVisible: m.isVisible,
    isErrorMessage: m.isErrorMessage,
    content: m.content,
    context: m.context,
  };
}

/** The last non-user (assistant) message, or `undefined` if none. */
function lastAssistant(visible: AgentChatMessage[]): AgentChatMessage | undefined {
  for (let i = visible.length - 1; i >= 0; i--) {
    if (visible[i].sender !== USER_SENDER) return visible[i];
  }
  return undefined;
}

/** The nearest preceding user message — the prompt that classifies the turn. */
function precedingUserMessage(
  visible: AgentChatMessage[],
  index: number
): AgentChatMessage | undefined {
  for (let i = index - 1; i >= 0; i--) {
    if (visible[i].sender === USER_SENDER) return visible[i];
  }
  return undefined;
}

/**
 * Research progress for one assistant turn, or null when the turn is not a
 * research run or has not made its first tool call yet (the panel only takes
 * over once there is something to summarize).
 */
function researchProgressFor(
  visible: AgentChatMessage[],
  index: number,
  message: AgentChatMessage,
  isAssistant: boolean
) {
  if (!isAssistant || !isResearchRun(precedingUserMessage(visible, index)?.message)) return null;
  const events = (message.parts ?? [])
    .filter(
      (part): part is Extract<AgentMessagePart, { kind: "tool_call" }> => part.kind === "tool_call"
    )
    .map(toResearchToolEvent);
  return deriveResearchProgress(events);
}

const AgentChatMessages = memo(
  ({
    messages,
    app,
    currentPlan,
    pendingToolPermissions,
    pendingAskUserQuestions,
    chatBackend,
    isLoading,
  }: AgentChatMessagesProps) => {
    const visible = useMemo(() => messages.filter((m) => m.isVisible), [messages]);
    const adapted = useMemo(() => visible.map(toChatMessageView), [visible]);
    const { containerMinHeight, scrollContainerCallbackRef, getMessageKey } = useChatScrolling({
      chatHistory: adapted,
    });

    const showPlanCard = currentPlan != null && currentPlan.decision === "pending";
    const inlinePlanCard = showPlanCard ? (
      <PlanProposalCard plan={currentPlan} app={app} chatBackend={chatBackend} />
    ) : null;
    const pendingQuestion = pendingAskUserQuestions[0];
    const pendingPermission = pendingQuestion ? undefined : pendingToolPermissions[0];
    // Questions take priority so the separate resolver queues have a stable
    // presentation policy without carrying cross-type sequencing state.
    // https://github.com/logancyang/obsidian-copilot/issues/2948
    const pendingActionId = pendingQuestion
      ? `question:${pendingQuestion.requestId}`
      : pendingPermission
        ? `permission:${pendingPermission.toolCall.toolCallId}`
        : null;

    // The latest assistant message owns both timer states: it ticks while that
    // turn is in flight, then retains the frozen duration until the next turn
    // appends a newer placeholder and naturally retires this row.
    const latestAssistant = useMemo(() => lastAssistant(visible), [visible]);
    const streamingMessageId = isLoading ? latestAssistant?.id : undefined;

    // Opens the finished research note the same way chat source links do.
    const openResearchNote = useCallback(
      (path: string) => {
        const file = app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) void openFileInWorkspace(app, file);
      },
      [app]
    );

    return (
      <div className="tw-flex tw-h-full tw-flex-1 tw-flex-col tw-overflow-hidden">
        <div
          ref={scrollContainerCallbackRef}
          data-testid="chat-messages"
          className="tw-relative tw-flex tw-w-full tw-flex-1 tw-select-text tw-flex-col tw-items-start tw-justify-start tw-overflow-y-auto tw-scroll-smooth tw-break-words tw-text-[calc(var(--font-text-size)_-_2px)]"
        >
          {visible.map((message, index) => {
            const isLastMessage = index === visible.length - 1;
            // A plan remains part of the transcript, so it supplies tail
            // content. Blocking actions live in their own rail and do not
            // change the transcript's scroll headroom.
            const shouldApplyMinHeight =
              isLastMessage && message.sender !== USER_SENDER && !showPlanCard;
            const adaptedMessage = adapted[index];
            // When an assistant message has structured parts, the trail owns
            // its entire body — `text` parts already cover streamed prose, so
            // an additional `ChatSingleMessage` would duplicate it.
            const isAssistant = message.sender !== USER_SENDER;
            const hasParts = (message.parts?.length ?? 0) > 0;
            const renderTrail = isAssistant && hasParts;
            const researchProgress = renderTrail
              ? researchProgressFor(visible, index, message, isAssistant)
              : null;
            const ownsTurnDuration = isAssistant && message.id === latestAssistant?.id;
            const completedTurnDurationMs = ownsTurnDuration ? message.turnDurationMs : undefined;
            const runningTurnStartedAtMs =
              ownsTurnDuration && message.id === streamingMessageId
                ? message.timestamp?.epoch
                : undefined;
            const completedTurnDuration =
              completedTurnDurationMs !== undefined ? (
                <AgentTurnDurationIndicator
                  status="complete"
                  durationMs={completedTurnDurationMs}
                  inline
                />
              ) : null;
            const runningTurnDuration =
              runningTurnStartedAtMs !== undefined ? (
                <AgentTurnDurationIndicator status="running" startedAtMs={runningTurnStartedAtMs} />
              ) : null;
            // The streaming placeholder (empty body, no parts) renders the
            // whole-turn timer in-place, so the user sees progress the moment
            // they hit send rather than an empty assistant bubble.
            const isStreamingPlaceholder =
              isAssistant && message.id === streamingMessageId && !hasParts && !message.message;
            // A multi-agent turn owns this message's body — the segmented tab
            // row replaces the plain assistant text and the streaming spinner
            // (its per-agent slots show their own live states). `message.fanout`
            // is present for BOTH the live in-flight turn and a reloaded
            // transcript whose composite body was parsed back into a turn.
            const fanoutTurn = isAssistant ? message.fanout : undefined;

            return (
              <div
                key={getMessageKey(adaptedMessage, index)}
                data-message-key={getMessageKey(adaptedMessage, index)}
                className="tw-w-full"
                style={{
                  minHeight: shouldApplyMinHeight ? `${containerMinHeight}px` : "auto",
                }}
              >
                {fanoutTurn ? (
                  <div className="tw-px-3 tw-pt-2">
                    <FanoutMessageCard
                      message={message}
                      turn={fanoutTurn}
                      app={app}
                      footerStart={completedTurnDuration}
                    />
                    {runningTurnDuration}
                  </div>
                ) : isStreamingPlaceholder ? (
                  <div className="tw-px-3 tw-pt-2">{runningTurnDuration}</div>
                ) : renderTrail ? (
                  <div className="tw-px-3 tw-pt-2">
                    <AgentTrail
                      parts={message.parts!}
                      isStreaming={message.id === streamingMessageId}
                      turnStartedAtMs={runningTurnStartedAtMs}
                      turnDurationMs={completedTurnDurationMs}
                      timestamp={message.timestamp?.display}
                      app={app}
                      turnStopReason={message.turnStopReason}
                      researchProgress={researchProgress}
                      onOpenResearchNote={openResearchNote}
                    />
                  </div>
                ) : (
                  // Agent Mode has no per-message regenerate / edit / delete flow
                  // yet (ACP owns conversation history server-side), so no
                  // lifecycle handlers are wired — ChatButtons renders only the
                  // copy / insert actions it can honor.
                  <>
                    <ChatSingleMessage
                      message={adaptedMessage}
                      app={app}
                      isStreaming={false}
                      footerStart={completedTurnDuration}
                    />
                    {runningTurnDuration ? (
                      <div className="tw-px-3">{runningTurnDuration}</div>
                    ) : null}
                  </>
                )}
                {isAssistant && !hasParts && (message.sourceReferences?.length ?? 0) > 0 ? (
                  <div className="tw-px-3 tw-pb-2">
                    <AgentSourceList app={app} sources={message.sourceReferences ?? []} />
                  </div>
                ) : null}
              </div>
            );
          })}
          {inlinePlanCard}
        </div>
        {pendingActionId ? (
          <div
            role="region"
            aria-label="Pending agent actions"
            data-testid="agent-action-rail"
            // A verbose question can exceed a short chat pane. Bound and scroll
            // the rail so its resolution controls remain reachable.
            // https://github.com/logancyang/obsidian-copilot/issues/2948
            className="tw-max-h-full tw-w-full tw-overflow-y-auto tw-bg-primary"
          >
            <div key={pendingActionId} data-action-id={pendingActionId}>
              {pendingQuestion ? (
                <AskUserQuestionCard
                  request={pendingQuestion}
                  onResolve={chatBackend.resolveAskUserQuestion.bind(chatBackend)}
                />
              ) : pendingPermission ? (
                <ToolPermissionCard
                  request={pendingPermission}
                  onResolve={chatBackend.resolveToolPermission.bind(chatBackend)}
                />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    );
  }
);

AgentChatMessages.displayName = "AgentChatMessages";

export default AgentChatMessages;
