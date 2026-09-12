import type { Meta, StoryObj } from "@/lib/story";
import type CopilotPlugin from "@/main";
import React from "react";

import { QuickAskMessageComponent } from "./QuickAskMessage";

type QuickAskMessageProps = React.ComponentProps<typeof QuickAskMessageComponent>;

const noop = () => undefined;

const base = {
  message: {
    id: "m1",
    role: "assistant" as const,
    content: "The **Agentic AI Summit** runs August 1–2 at the Marriott.",
    timestamp: 0,
  },
  isStreaming: false,
  isLastAssistantMessage: true,
  onCopy: noop,
  onInsert: noop,
  onReplace: noop,
  hasSelection: true,
  isReplaceValid: true,
  replaceInvalidReason: null,
  filePathSnapshot: null,
  plugin: {} as CopilotPlugin,
};

const meta = {
  title: "Quick Ask/Message",
  component: QuickAskMessageComponent,
  parameters: { gallery: { host: "popover", layout: "padded" } },
} satisfies Meta<QuickAskMessageProps>;
export default meta;

export const StreamingProse: StoryObj<QuickAskMessageProps> = {
  args: { ...base, isStreaming: true },
};

export const StreamingWithToolActivity: StoryObj<QuickAskMessageProps> = {
  args: {
    ...base,
    isStreaming: true,
    message: {
      ...base.message,
      content: "Reading the two calendar accounts first…",
      toolStatusLabel: "Working: Read",
    },
  },
};

export const AgentTurnError: StoryObj<QuickAskMessageProps> = {
  args: {
    ...base,
    message: {
      ...base.message,
      content:
        "**Error:** No active agent session. Open Agent Chat once to start a session, then try Agent mode again.",
      isError: true,
    },
  },
};
