import { ResearchProgressCard } from "@/agentMode/ui/ResearchProgressCard";
import type { ResearchProgress } from "@/agentMode/ui/researchProgress";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";

function progress(overrides: Partial<ResearchProgress> = {}): ResearchProgress {
  return {
    steps: [
      { id: "plan", status: "done" },
      { id: "vault", status: "done", count: 3 },
      { id: "web", status: "active", count: 0 },
      { id: "write", status: "pending" },
    ],
    ...overrides,
  };
}

describe("ResearchProgressCard", () => {
  describe("ResearchProgressCard()", () => {
    it("renders the four workflow steps with their statuses and gather counts", () => {
      const { container } = render(<ResearchProgressCard progress={progress()} />);

      expect(screen.getByTestId("research-progress-card")).toBeTruthy();
      expect(screen.getByTestId("research-step-plan").dataset.stepStatus).toBe("done");
      expect(screen.getByTestId("research-step-vault").dataset.stepStatus).toBe("done");
      expect(screen.getByTestId("research-step-web").dataset.stepStatus).toBe("active");
      expect(screen.getByTestId("research-step-write").dataset.stepStatus).toBe("pending");
      expect(screen.getByTestId("research-step-vault").textContent).toContain("3");
      expect(screen.getByText("Plan")).toBeTruthy();
      expect(screen.getByText("Vault")).toBeTruthy();
      expect(screen.getByText("Web")).toBeTruthy();
      expect(screen.getByText("Write")).toBeTruthy();
      // Status glyphs: done check, active spinner, pending dim dot.
      expect(container.querySelector(".lucide-check")).toBeTruthy();
      expect(container.querySelector(".lucide-loader-circle")).toBeTruthy();
    });

    it("omits the count badge while a gather step has nothing to show", () => {
      render(
        <ResearchProgressCard
          progress={progress({
            steps: [
              { id: "plan", status: "active" },
              { id: "vault", status: "active", count: 0 },
              { id: "web", status: "active", count: 0 },
              { id: "write", status: "pending" },
            ],
          })}
        />
      );
      expect(screen.getByTestId("research-step-vault").textContent).not.toContain("0");
    });

    it("omits the target-note row while the run has not written a note", () => {
      render(<ResearchProgressCard progress={progress()} />);
      expect(screen.queryByTestId("research-target-note")).toBeNull();
    });

    it("opens the finished research note through onOpenNote", () => {
      const onOpenNote = jest.fn();
      render(
        <ResearchProgressCard
          progress={progress({ targetNotePath: "Research/Deep sea vents.md" })}
          onOpenNote={onOpenNote}
        />
      );

      fireEvent.click(screen.getByTestId("research-target-note"));
      expect(onOpenNote).toHaveBeenCalledWith("Research/Deep sea vents.md");
    });

    it("renders the target note as plain text without a handler", () => {
      render(<ResearchProgressCard progress={progress({ targetNotePath: "Research/Tides.md" })} />);

      const row = screen.getByTestId("research-target-note");
      expect(row.textContent).toContain("Research/Tides.md");
      expect(row.tagName).not.toBe("BUTTON");
    });
  });
});
