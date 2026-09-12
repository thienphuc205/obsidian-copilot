import { AgentChatControls } from "@/agentMode/ui/AgentChatControls";
import { TooltipProvider } from "@/components/ui/tooltip";
import { render, screen } from "@testing-library/react";
import * as React from "react";

// Autosave on so the Save-Chat button stays out of the way; this suite is about
// the left slot, not the right-side control cluster.
jest.mock("@/settings/model", () => ({
  useSettingsValue: jest.fn().mockReturnValue({ autosaveChat: true }),
}));

/** The control-bar buttons need a Radix `TooltipProvider` ancestor, which the
 * chat-view root supplies in the app. */
function renderControls() {
  return render(
    <TooltipProvider>
      <AgentChatControls onNewChat={() => {}} />
    </TooltipProvider>
  );
}

describe("AgentChatControls", () => {
  it("renders the control bar without any upsell surface", () => {
    renderControls();

    expect(screen.queryByText(/Plus/)).toBeNull();
  });
});
