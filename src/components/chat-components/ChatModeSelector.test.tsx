import { ChainType } from "@/chainType";
import { ChatModeSelector } from "@/components/chat-components/ChatModeSelector";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";

describe("ChatModeSelector", () => {
  beforeAll(() => {
    (window as unknown as { activeDocument: Document }).activeDocument = window.document;
    if (!("PointerEvent" in window)) {
      (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = MouseEvent;
    }
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.releasePointerCapture = () => {};
    Element.prototype.scrollIntoView = () => {};
  });

  describe("ChatModeSelector()", () => {
    it("offers Free Chat only, without a Copilot Plus paywall entry https://github.com/Brevilabs/obsidian-copilot-private/issues/286", () => {
      const onModeChange = jest.fn();
      render(
        <ChatModeSelector
          selectedChain={ChainType.LLM_CHAIN}
          onModeChange={onModeChange}
          defaultOpen
        />
      );

      expect(screen.getAllByText("chat (free)")).toHaveLength(2);
      expect(screen.queryByText("copilot plus")).toBeNull();
      expect(screen.queryByText(/vault QA/i)).toBeNull();
    });

    it("selecting the only entry switches to the LLM chain", () => {
      const onModeChange = jest.fn();
      render(
        <ChatModeSelector
          selectedChain={ChainType.LLM_CHAIN}
          onModeChange={onModeChange}
          defaultOpen
        />
      );

      expect(screen.getAllByText("chat (free)").length).toBeGreaterThan(0);

      fireEvent.click(screen.getAllByText("chat (free)")[1]);
      expect(onModeChange).toHaveBeenCalledWith(ChainType.LLM_CHAIN);
    });
  });
});
