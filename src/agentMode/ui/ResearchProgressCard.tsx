import React from "react";
import { BookOpen, Check, FilePen, Globe, List, Loader2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  ResearchProgress,
  ResearchProgressStep,
  ResearchStepId,
  ResearchStepStatus,
} from "@/agentMode/ui/researchProgress";

export interface ResearchProgressCardProps {
  progress: ResearchProgress;
  /** Opens the finished research note; absent renders the target as plain text. */
  onOpenNote?: (path: string) => void;
}

const STEP_META: Record<ResearchStepId, { label: string; Icon: LucideIcon }> = {
  plan: { label: "Plan", Icon: List },
  vault: { label: "Vault", Icon: BookOpen },
  web: { label: "Web", Icon: Globe },
  write: { label: "Write", Icon: FilePen },
};

/**
 * Compact live status panel for a research run (Plan → Vault → Web → Write).
 * Replaces the raw tool-call trail for research turns so the workflow reads
 * at a glance instead of as a list of individual calls.
 */
export const ResearchProgressCard: React.FC<ResearchProgressCardProps> = ({
  progress,
  onOpenNote,
}) => {
  return (
    <div
      data-testid="research-progress-card"
      className="tw-my-1 tw-flex tw-w-full tw-flex-col tw-gap-1 tw-rounded tw-border tw-border-border tw-bg-secondary tw-px-2 tw-py-1.5"
    >
      {progress.steps.map((step) => (
        <StepRow key={step.id} step={step} />
      ))}
      {progress.targetNotePath ? (
        <NoteRow path={progress.targetNotePath} onOpenNote={onOpenNote} />
      ) : null}
    </div>
  );
};

function StepRow({ step }: { step: ResearchProgressStep }) {
  const { label, Icon } = STEP_META[step.id];
  return (
    <div
      data-testid={`research-step-${step.id}`}
      data-step-status={step.status}
      className="tw-flex tw-items-center tw-gap-1.5 tw-text-sm"
    >
      <Icon className="tw-size-3.5 tw-shrink-0 tw-text-muted" />
      <span
        className={cn(
          "tw-font-medium",
          step.status === "done" ? "tw-text-muted" : "tw-text-normal"
        )}
      >
        {label}
      </span>
      {typeof step.count === "number" && step.count > 0 ? (
        <span className="tw-text-xs tw-text-muted">{step.count}</span>
      ) : null}
      <span className="tw-flex-1" />
      <StatusGlyph status={step.status} />
    </div>
  );
}

function StatusGlyph({ status }: { status: ResearchStepStatus }) {
  if (status === "done") {
    return <Check aria-label="done" className="tw-size-3 tw-shrink-0 tw-text-success" />;
  }
  if (status === "active") {
    return (
      <Loader2
        aria-label="active"
        className="tw-size-3 tw-shrink-0 tw-animate-spin tw-text-loading"
      />
    );
  }
  // `bg-current` picks up the faint text color, so the pending dot dims
  // without a dedicated background token.
  return (
    <span
      aria-label="pending"
      className="tw-size-1.5 tw-shrink-0 tw-rounded-full tw-bg-current tw-text-faint"
    />
  );
}

function NoteRow({ path, onOpenNote }: { path: string; onOpenNote?: (path: string) => void }) {
  const className =
    "tw-flex tw-min-w-0 tw-items-center tw-gap-1.5 tw-border-t tw-border-border tw-pt-1 tw-text-xs tw-text-muted hover:tw-text-normal";
  const content = (
    <>
      <FilePen className="tw-size-3 tw-shrink-0" />
      <span className="tw-min-w-0 tw-flex-1 tw-truncate">{path}</span>
    </>
  );
  if (!onOpenNote) {
    return (
      <div data-testid="research-target-note" className={className}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-testid="research-target-note"
      className={cn(className, "tw-text-left")}
      onClick={() => onOpenNote(path)}
    >
      {content}
    </button>
  );
}
