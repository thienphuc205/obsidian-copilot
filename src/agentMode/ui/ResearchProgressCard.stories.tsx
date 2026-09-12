import { ResearchProgressCard } from "@/agentMode/ui/ResearchProgressCard";
import type { ResearchProgress } from "@/agentMode/ui/researchProgress";
import type { Meta, StoryObj } from "@/lib/story";
import React from "react";

type ResearchProgressCardProps = React.ComponentProps<typeof ResearchProgressCard>;

const RUNNING: ResearchProgress = {
  steps: [
    { id: "plan", status: "done" },
    { id: "vault", status: "done", count: 4 },
    { id: "web", status: "active", count: 0 },
    { id: "write", status: "pending" },
  ],
};

const COMPLETE: ResearchProgress = {
  steps: [
    { id: "plan", status: "done" },
    { id: "vault", status: "done", count: 4 },
    { id: "web", status: "done", count: 2 },
    { id: "write", status: "done" },
  ],
  targetNotePath: "Research/Deep sea vents.md",
};

const meta = {
  title: "Agent Mode/Research Progress Card",
  component: ResearchProgressCard,
  args: {
    progress: RUNNING,
    onOpenNote: () => undefined,
  },
  parameters: { gallery: { host: "leaf", layout: "padded" } },
} satisfies Meta<ResearchProgressCardProps>;
export default meta;

export const RunInProgress: StoryObj<ResearchProgressCardProps> = {};

export const CompleteWithNote: StoryObj<ResearchProgressCardProps> = {
  args: { progress: COMPLETE },
};

export const JustStarted: StoryObj<ResearchProgressCardProps> = {
  args: {
    progress: {
      steps: [
        { id: "plan", status: "active" },
        { id: "vault", status: "active", count: 0 },
        { id: "web", status: "active", count: 0 },
        { id: "write", status: "pending" },
      ],
    },
  },
};
