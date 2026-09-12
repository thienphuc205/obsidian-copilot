import type { AgentChatBackend } from "@/agentMode/session/AgentChatBackend";
import type {
  AgentChatMessage,
  AskUserQuestionPrompt,
  CurrentPlan,
  PermissionPrompt,
} from "@/agentMode/session/types";
import AgentChatMessages from "@/agentMode/ui/AgentChatMessages";
import { AI_SENDER, USER_SENDER } from "@/constants";
import { act, render, screen } from "@testing-library/react";
import React from "react";

type AgentChatMessagesProps = React.ComponentProps<typeof AgentChatMessages>;

jest.mock("@/hooks/useChatScrolling", () => ({
  // eslint-disable-next-line @eslint-react/hooks-extra/no-unnecessary-use-prefix -- mocks the real hook; name must match the export
  useChatScrolling: () => ({
    containerMinHeight: 0,
    scrollContainerCallbackRef: jest.fn(),
    getMessageKey: (message: { id: string }) => message.id,
  }),
}));

jest.mock("@/components/chat-components/ChatSingleMessage", () => ({
  __esModule: true,
  default: ({
    message,
    footerStart,
  }: {
    message: { message: string };
    footerStart?: React.ReactNode;
  }) => (
    <div>
      {message.message}
      <div data-testid="single-message-footer">{footerStart}</div>
    </div>
  ),
}));

jest.mock("@/agentMode/ui/AgentTrailView", () => ({
  AgentTrail: ({
    timestamp,
    researchProgress,
  }: {
    timestamp?: string;
    researchProgress?: unknown;
  }) => (
    <div>
      <div data-testid="agent-trail-timestamp">{timestamp}</div>
      <div data-testid="agent-trail-research">
        {researchProgress ? "research-panel" : "plain-trail"}
      </div>
    </div>
  ),
}));

jest.mock("@/agentMode/ui/AgentSourceList", () => ({
  AgentSourceList: ({ sources }: { sources: Array<{ title: string }> }) => (
    <div data-testid="restored-source-list">{sources.map((source) => source.title).join(", ")}</div>
  ),
}));

jest.mock("@/agentMode/ui/ToolPermissionCard", () => ({
  ToolPermissionCard: ({ request }: { request: PermissionPrompt }) => (
    <div>Permission {request.toolCall.toolCallId}</div>
  ),
}));

jest.mock("@/agentMode/ui/AskUserQuestionCard", () => ({
  AskUserQuestionCard: ({ request }: { request: AskUserQuestionPrompt }) => (
    <div>Question {request.requestId}</div>
  ),
}));

jest.mock("@/agentMode/ui/PlanProposalCard", () => ({
  PlanProposalCard: ({ plan }: { plan: CurrentPlan }) => <div>Plan {plan.id}</div>,
}));

function assistantMessage(
  id: string,
  timestampMs: number,
  overrides: Partial<AgentChatMessage> = {}
): AgentChatMessage {
  return {
    id,
    sender: AI_SENDER,
    message: "Finished response",
    timestamp: { epoch: timestampMs, display: "", fileName: "" },
    isVisible: true,
    ...overrides,
  };
}

function userMessage(id: string, text: string): AgentChatMessage {
  return {
    id,
    sender: USER_SENDER,
    message: text,
    timestamp: { epoch: 0, display: "", fileName: "" },
    isVisible: true,
  };
}

const chatBackend = {
  resolveToolPermission: jest.fn(),
  resolveAskUserQuestion: jest.fn(),
} as unknown as AgentChatBackend;

function permission(id: string): PermissionPrompt {
  return {
    sessionId: "session-1",
    toolCall: { toolCallId: id, status: "pending", title: id },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  };
}

function question(id: string): AskUserQuestionPrompt {
  return {
    sessionId: "session-1",
    requestId: id,
    questions: [{ question: id, options: [{ label: "Yes" }] }],
  };
}

function plan(id: string): CurrentPlan {
  return {
    id,
    revision: 1,
    body: "Review the plan",
    title: "Plan",
    permissionGated: true,
    decision: "pending",
  };
}

function renderMessages(
  messages: AgentChatMessage[],
  isLoading: boolean,
  overrides: Partial<AgentChatMessagesProps> = {}
) {
  const props: AgentChatMessagesProps = {
    messages,
    app: {} as never,
    currentPlan: null,
    pendingToolPermissions: [],
    pendingAskUserQuestions: [],
    chatBackend,
    isLoading,
    ...overrides,
  };
  return { ...render(<AgentChatMessages {...props} />), props };
}

describe("AgentChatMessages", () => {
  describe("AgentChatMessages()", () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(200_000);
    });

    afterEach(() => jest.useRealTimers());

    it("retains the latest completed turn duration with a static icon", () => {
      const { container } = renderMessages(
        [assistantMessage("answer-1", 62_000, { turnDurationMs: 138_000 })],
        false
      );

      expect(screen.getByText("2m 18s")).toBeTruthy();
      expect(screen.getByTestId("single-message-footer").textContent).toContain(
        "Worked for 2m 18s"
      );
      expect(container.querySelector(".copilot-spinner")).toBeTruthy();
      expect(container.querySelector(".copilot-spinner-dot-0")).toBeNull();
    });

    it("retires the prior duration when the next turn starts", () => {
      const { container } = renderMessages(
        [
          assistantMessage("answer-1", 1_000, { turnDurationMs: 51_000 }),
          assistantMessage("answer-2", 198_000, { message: "", parts: [] }),
        ],
        true
      );

      expect(screen.queryByText("51s")).toBeNull();
      expect(screen.getByText("2s")).toBeTruthy();
      expect(container.querySelector(".copilot-spinner")).toBeTruthy();

      act(() => jest.advanceTimersByTime(1_000));
      expect(screen.getByText("3s")).toBeTruthy();
    });

    it("passes the message timestamp to a structured trail without a duration", () => {
      const timestamp = "2026/08/07 20:31:10";
      renderMessages(
        [
          assistantMessage("answer-1", 62_000, {
            timestamp: { epoch: 62_000, display: timestamp, fileName: "20260807_203110" },
            parts: [{ kind: "thought", text: "Inspect the response." }],
          }),
        ],
        false
      );

      expect(screen.getByTestId("agent-trail-timestamp").textContent).toBe(timestamp);
    });

    it("shows restored sources on a plain assistant message without duplicating live tool sources", () => {
      const sourceReferences = [
        {
          title: "Provider docs",
          path: "https://example.test/docs",
          url: "https://example.test/docs",
          kind: "web" as const,
          score: 0,
        },
      ];
      const { rerender, props } = renderMessages(
        [assistantMessage("loaded", 62_000, { sourceReferences })],
        false
      );

      expect(screen.getByTestId("restored-source-list").textContent).toBe("Provider docs");

      rerender(
        <AgentChatMessages
          {...props}
          messages={[
            assistantMessage("live", 63_000, {
              sourceReferences,
              parts: [
                {
                  kind: "tool_call",
                  id: "web-1",
                  title: "web_search",
                  status: "completed",
                  sourceReferences,
                },
              ],
            }),
          ]}
        />
      );

      expect(screen.queryByTestId("restored-source-list")).toBeNull();
    });

    it("shows questions before permissions and reveals a permission after questions clear for https://github.com/logancyang/obsidian-copilot/issues/2948", () => {
      const { rerender, props } = renderMessages([assistantMessage("answer-1", 62_000)], false, {
        pendingToolPermissions: [permission("permission-first"), permission("permission-second")],
        pendingAskUserQuestions: [question("question-first")],
      });

      const rail = screen.getByRole("region", { name: "Pending agent actions" });
      const firstAction = rail.querySelector("[data-action-id]");
      expect(Array.from(rail.querySelectorAll("[data-action-id]"), (el) => el.textContent)).toEqual(
        ["Question question-first"]
      );
      expect(screen.getByTestId("chat-messages").textContent).not.toContain("question-first");

      rerender(
        <AgentChatMessages
          {...props}
          pendingToolPermissions={[permission("permission-first"), permission("permission-second")]}
          pendingAskUserQuestions={[]}
        />
      );

      expect(Array.from(rail.querySelectorAll("[data-action-id]"), (el) => el.textContent)).toEqual(
        ["Permission permission-first"]
      );
      expect(rail.querySelector("[data-action-id]")).not.toBe(firstAction);
    });

    it("bounds and scrolls a tall action rail so controls remain reachable for https://github.com/logancyang/obsidian-copilot/issues/2948", () => {
      renderMessages([], false, {
        pendingAskUserQuestions: [question("empty-chat-question")],
      });

      const rail = screen.getByTestId("agent-action-rail");
      expect(rail.textContent).toContain("empty-chat-question");
      expect(rail.className).toContain("tw-w-full");
      expect(rail.className).toContain("tw-max-h-full");
      expect(rail.className).toContain("tw-overflow-y-auto");
      expect(rail.className).not.toContain("tw-shrink-0");
      expect(rail.className).not.toContain("tw-border");
    });

    it("keeps a plan-only state in the transcript without creating an action rail", () => {
      renderMessages([], false, { currentPlan: plan("plan-1") });

      expect(screen.getByTestId("chat-messages").textContent).toContain("Plan plan-1");
      expect(screen.queryByTestId("agent-action-rail")).toBeNull();
    });

    it("swaps the trail for the research panel on a research run with tool calls", () => {
      renderMessages(
        [
          userMessage(
            "prompt-1",
            "Use the research skill for: Tides. Show the plan first, search the vault before " +
              "the web, and write the result into the research note you create."
          ),
          assistantMessage("answer-1", 62_000, {
            parts: [
              {
                kind: "tool_call",
                id: "grep-1",
                title: "Grep",
                status: "completed",
                input: { pattern: "tides" },
              },
              {
                kind: "tool_call",
                id: "web-1",
                title: "webSearch",
                status: "completed",
                input: { query: "tides" },
              },
              {
                kind: "tool_call",
                id: "write-1",
                title: "Write",
                status: "completed",
                input: { file_path: "Research/Tides.md" },
              },
            ],
          }),
        ],
        false
      );

      expect(screen.getByTestId("agent-trail-research").textContent).toBe("research-panel");
    });

    it("keeps the plain trail before a research run makes its first tool call", () => {
      renderMessages(
        [
          userMessage("prompt-1", "Use the research skill for: Tides. Show the plan first."),
          assistantMessage("answer-1", 62_000, {
            parts: [{ kind: "thought", text: "Planning the search." }],
          }),
        ],
        false
      );

      expect(screen.getByTestId("agent-trail-research").textContent).toBe("plain-trail");
    });

    it("keeps the plain trail for tool activity on a non-research turn", () => {
      renderMessages(
        [
          userMessage("prompt-1", "Summarize my research notes about tides"),
          assistantMessage("answer-1", 62_000, {
            parts: [
              {
                kind: "tool_call",
                id: "grep-1",
                title: "Grep",
                status: "completed",
                input: { pattern: "tides" },
              },
            ],
          }),
        ],
        false
      );

      expect(screen.getByTestId("agent-trail-research").textContent).toBe("plain-trail");
    });
  });
});
