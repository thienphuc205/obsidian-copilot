import { QuickAskMessageComponent } from "@/components/quick-ask/QuickAskMessage";
import type CopilotPlugin from "@/main";
import { render, screen } from "@testing-library/react";
import React from "react";

jest.mock("obsidian", () => {
  const actual: Record<string, unknown> = jest.requireActual("obsidian");
  return {
    ...actual,
    MarkdownRenderer: { renderMarkdown: jest.fn(async () => undefined) },
  };
});

const baseMessage = {
  id: "m1",
  role: "assistant" as const,
  content: "answer text",
  timestamp: 0,
};

const noop = () => undefined;

function renderMessage(props: Partial<Parameters<typeof QuickAskMessageComponent>[0]> = {}) {
  return render(
    <QuickAskMessageComponent
      message={baseMessage}
      isStreaming={false}
      isLastAssistantMessage={true}
      onCopy={noop}
      onInsert={noop}
      onReplace={noop}
      hasSelection={false}
      isReplaceValid={true}
      replaceInvalidReason={null}
      filePathSnapshot={null}
      plugin={{} as CopilotPlugin}
      {...props}
    />
  );
}

describe("QuickAskMessageComponent", () => {
  describe("agent turn rendering", () => {
    it("renders the compact tool status line while streaming with tool activity", () => {
      renderMessage({
        isStreaming: true,
        message: { ...baseMessage, toolStatusLabel: "Working: Read" },
      });

      const status = screen.getByText("Working: Read");
      expect(status.closest("[data-quick-ask-tool-status]")).toBeTruthy();
    });

    it("renders error messages with the error style and no action bar", () => {
      renderMessage({ message: { ...baseMessage, isError: true, content: "**Error:** boom" } });

      expect(screen.getByText("**Error:** boom")).toBeTruthy();
      expect(screen.queryByTitle("Copy to clipboard")).toBeNull();
    });

    it("renders normal assistant messages without a tool status line", () => {
      renderMessage({ isStreaming: true });

      expect(screen.queryByText("data-quick-ask-tool-status")).toBeNull();
      expect(screen.queryByText(/^Working:/)).toBeNull();
      expect(screen.getByText(/answer text/)).toBeTruthy();
    });
  });
});
