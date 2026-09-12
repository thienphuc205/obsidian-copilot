import { ChatButtons } from "@/components/chat-components/ui/ChatButtons";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Meta, StoryObj } from "@/lib/story";
import React from "react";

type Props = React.ComponentProps<typeof ChatButtons>;

const meta = {
  title: "Chat/Message Actions",
  parameters: { gallery: { host: "leaf", layout: "padded" } },
  component: (args: Props) => (
    <TooltipProvider>
      <div className="tw-group">
        <ChatButtons {...args} />
      </div>
    </TooltipProvider>
  ),
} satisfies Meta<Props>;
export default meta;

export const UserPdfSources: StoryObj<Props> = {
  args: {
    message: { sender: "user", message: "Read this PDF", isVisible: true, timestamp: null },
    hasSources: true,
    onShowSources: () => {},
  },
};

export const UserWithoutSources: StoryObj<Props> = {
  args: {
    message: { sender: "user", message: "Hello", isVisible: true, timestamp: null },
    hasSources: false,
  },
};
