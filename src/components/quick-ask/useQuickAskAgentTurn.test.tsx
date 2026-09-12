import { useQuickAskAgentTurn } from "@/components/quick-ask/useQuickAskAgentTurn";
import type { AgentSession } from "@/agentMode/session/AgentSession";
import type { AgentChatMessage, AgentMessagePart } from "@/agentMode/session/types";
import type CopilotPlugin from "@/main";
import { act, renderHook, waitFor } from "@testing-library/react";
import { Notice } from "obsidian";

/**
 * Builds an `AgentChatMessage` with only the fields the projection reads.
 */
function transcriptMessage(
  overrides: Partial<AgentChatMessage> & Pick<AgentChatMessage, "id" | "sender">
): AgentChatMessage {
  return {
    message: "",
    timestamp: { epoch: 1_700_000_000_000, display: "", fileName: "" },
    isVisible: true,
    ...overrides,
  };
}

interface SessionStub {
  session: AgentSession;
  store: {
    getDisplayMessages: jest.Mock;
  };
  sendPrompt: jest.Mock;
  cancel: jest.Mock;
  getStatus: jest.Mock;
  /** Fire a manager-level notification (streams/subscription tick). */
  notify: () => void;
}

function makeSession(overrides: Partial<SessionStub["session"]> = {}): SessionStub {
  const listeners = new Set<() => void>();
  const store = { getDisplayMessages: jest.fn((): AgentChatMessage[] => []) };
  const sendPrompt = jest.fn((): { turn: Promise<unknown> } => ({ turn: Promise.resolve() }));
  const cancel = jest.fn(async () => undefined);
  const getStatus = jest.fn(() => "idle");
  const session = {
    store,
    sendPrompt,
    cancel,
    getStatus,
    ...overrides,
  } as unknown as AgentSession;
  const notify = () => {
    for (const l of listeners) l();
  };
  return { session, store, sendPrompt, cancel, getStatus, notify };
}

/** Manager stub shape — the real class has private members we don't extend. */
interface ManagerStub {
  getActiveSession: () => AgentSession | null;
  subscribe: (listener: () => void) => () => void;
  notify: () => void;
}

function makeManager(sessionStub: SessionStub | null): ManagerStub {
  const listeners = new Set<() => void>();
  return {
    getActiveSession: jest.fn(() => (sessionStub ? sessionStub.session : null)),
    subscribe: jest.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    notify: () => listeners.forEach((l) => l()),
  };
}

function makePlugin(manager: ManagerStub | null): CopilotPlugin {
  return { agentSessionManager: manager } as unknown as CopilotPlugin;
}

function renderAgentTurn(params: { plugin: CopilotPlugin; selectedText?: string }) {
  return renderHook(() =>
    useQuickAskAgentTurn({
      plugin: params.plugin,
      selectedText: params.selectedText ?? "the selected passage",
    })
  );
}

describe("useQuickAskAgentTurn", () => {
  describe("useQuickAskAgentTurn()", () => {
    it("starts idle with no messages", () => {
      const stub = makeSession();
      const { result } = renderAgentTurn({ plugin: makePlugin(makeManager(stub)) });

      expect(result.current.messages).toEqual([]);
      expect(result.current.isStreaming).toBe(false);
    });

    describe("sendMessage()", () => {
      it("routes the turn through the active session with the selection + question prompt", async () => {
        const stub = makeSession();
        stub.sendPrompt.mockReturnValue({ turn: Promise.resolve() });
        const { result } = renderAgentTurn({ plugin: makePlugin(makeManager(stub)) });

        await act(async () => {
          await result.current.sendMessage("what does this do?");
        });

        expect(stub.sendPrompt).toHaveBeenCalledTimes(1);
        expect(stub.sendPrompt).toHaveBeenCalledWith(
          "Selected text:\nthe selected passage\n\nQuestion: what does this do?"
        );
      });

      it("appends the user message and a transient assistant message that fills with streamed text parts", async () => {
        let resolveTurn: (value: unknown) => void = () => undefined;
        const stub = makeSession();
        stub.sendPrompt.mockReturnValue({
          turn: new Promise((resolve) => {
            resolveTurn = resolve;
          }),
        });
        const manager = makeManager(stub);
        const { result } = renderAgentTurn({ plugin: makePlugin(manager) });

        let sendPromise: Promise<void> = Promise.resolve();
        act(() => {
          sendPromise = result.current.sendMessage("explain");
        });

        await waitFor(() => expect(stub.sendPrompt).toHaveBeenCalled());
        // The session appends user + empty placeholder synchronously on send;
        // the first tick discovers the placeholder (baseline: no parts).
        const emptyPlaceholder = transcriptMessage({ id: "placeholder-1", sender: "ai" });
        stub.store.getDisplayMessages.mockReturnValue([emptyPlaceholder]);
        await act(async () => {
          manager.notify();
        });

        // Simulate the session streaming thought + text parts into the placeholder.
        const placeholder = transcriptMessage({
          id: "placeholder-1",
          sender: "ai",
          message: "reasoning textfinal prose",
          parts: [
            { kind: "thought", text: "reasoning text" },
            { kind: "text", text: "final prose" },
          ] as AgentMessagePart[],
        });
        stub.store.getDisplayMessages.mockReturnValue([placeholder]);
        await act(async () => {
          manager.notify();
        });

        await act(async () => {
          resolveTurn(undefined);
          await sendPromise;
        });

        const assistant = result.current.messages.find((m) => m.role === "assistant");
        expect(assistant?.content).toBe("reasoning text\n\nfinal prose");
        expect(assistant?.isError).toBeUndefined();
      });

      it("shows the compact tool status line while a tool call is active, then drops it on completion", async () => {
        let resolveTurn: (value: unknown) => void = () => undefined;
        const stub = makeSession();
        stub.sendPrompt.mockReturnValue({
          turn: new Promise((resolve) => {
            resolveTurn = resolve;
          }),
        });
        const manager = makeManager(stub);
        const { result } = renderAgentTurn({ plugin: makePlugin(manager) });

        let sendPromise: Promise<void> = Promise.resolve();
        act(() => {
          sendPromise = result.current.sendMessage("summarize");
        });

        await waitFor(() => expect(stub.sendPrompt).toHaveBeenCalled());
        const emptyPlaceholder = transcriptMessage({ id: "placeholder-1", sender: "ai" });
        stub.store.getDisplayMessages.mockReturnValue([emptyPlaceholder]);
        await act(async () => {
          manager.notify();
        });

        const withTool = transcriptMessage({
          id: "placeholder-1",
          sender: "ai",
          parts: [
            { kind: "tool_call", id: "t1", title: "Read", status: "in_progress" },
          ] as AgentMessagePart[],
        });
        stub.store.getDisplayMessages.mockReturnValue([withTool]);
        await act(async () => {
          manager.notify();
        });

        const streaming = result.current.messages.find((m) => m.role === "assistant");
        expect(streaming?.toolStatusLabel).toBe("Working: Read");

        await act(async () => {
          resolveTurn(undefined);
          await sendPromise;
        });

        const settled = result.current.messages.find((m) => m.role === "assistant");
        expect(settled?.toolStatusLabel).toBeUndefined();
      });

      it("appends an error message when the turn rejects", async () => {
        const stub = makeSession();
        stub.sendPrompt.mockReturnValue({ turn: Promise.reject(new Error("backend died")) });
        const manager = makeManager(stub);
        const { result } = renderAgentTurn({ plugin: makePlugin(manager) });

        await act(async () => {
          await result.current.sendMessage("hello");
        });

        const assistant = result.current.messages.find((m) => m.role === "assistant");
        expect(assistant?.isError).toBe(true);
        expect(assistant?.content).toContain("**Error:** backend died");
        expect(Notice).toHaveBeenCalledWith("Error generating response. Please try again.");
      });

      it("fails closed with the error path when no active agent session exists", async () => {
        const { result } = renderAgentTurn({ plugin: makePlugin(makeManager(null)) });

        await act(async () => {
          await result.current.sendMessage("hello");
        });

        const assistant = result.current.messages.find((m) => m.role === "assistant");
        expect(assistant?.isError).toBe(true);
        expect(assistant?.content).toContain("No active agent session");
        expect(Notice).toHaveBeenCalledWith(
          "No active agent session. Open Agent Chat once to start a session."
        );
      });

      it("does not spawn or send when the shared session already has a turn in flight", async () => {
        const stub = makeSession();
        stub.getStatus.mockReturnValue("running");
        const { result } = renderAgentTurn({ plugin: makePlugin(makeManager(stub)) });

        await act(async () => {
          await result.current.sendMessage("hello");
        });

        expect(stub.sendPrompt).not.toHaveBeenCalled();
      });

      it("ignores empty input", async () => {
        const stub = makeSession();
        const { result } = renderAgentTurn({ plugin: makePlugin(makeManager(stub)) });

        await act(async () => {
          await result.current.sendMessage("   ");
        });

        expect(stub.sendPrompt).not.toHaveBeenCalled();
        expect(result.current.messages).toEqual([]);
      });

      it("ignores a second send while a turn is streaming (isStreaming gate)", async () => {
        let resolveTurn: (value: unknown) => void = () => undefined;
        const stub = makeSession();
        stub.sendPrompt.mockReturnValue({
          turn: new Promise((resolve) => {
            resolveTurn = resolve;
          }),
        });
        const { result } = renderAgentTurn({ plugin: makePlugin(makeManager(stub)) });

        let first: Promise<void> = Promise.resolve();
        act(() => {
          first = result.current.sendMessage("first");
        });
        await waitFor(() => expect(stub.sendPrompt).toHaveBeenCalledTimes(1));

        await act(async () => {
          await result.current.sendMessage("second");
        });
        expect(stub.sendPrompt).toHaveBeenCalledTimes(1);

        await act(async () => {
          resolveTurn(undefined);
          await first;
        });
      });
    });

    describe("stop()", () => {
      it("cancels the active session", async () => {
        const stub = makeSession();
        const { result } = renderAgentTurn({ plugin: makePlugin(makeManager(stub)) });

        result.current.stop();
        await waitFor(() => expect(stub.cancel).toHaveBeenCalledTimes(1));
      });
    });

    describe("clear()", () => {
      it("empties the panel messages", async () => {
        const stub = makeSession();
        const { result } = renderAgentTurn({ plugin: makePlugin(makeManager(stub)) });

        await act(async () => {
          await result.current.sendMessage("hello");
        });
        act(() => {
          result.current.clear();
        });

        expect(result.current.messages).toEqual([]);
      });
    });
  });
});
