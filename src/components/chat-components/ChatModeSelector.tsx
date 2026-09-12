import { ChainType } from "@/chainType";
import { Button } from "@/components/ui/button";
import { DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownMenu, DropdownMenuTrigger } from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import React from "react";

interface ChatModeSelectorProps {
  selectedChain: ChainType;
  onModeChange: (chainType: ChainType) => void;
  defaultOpen?: boolean;
}

/**
 * Render the single surviving Quick Chat mode. The Copilot Plus paywall entry
 * was removed along with the subscription itself; a stale persisted Plus chain
 * selection still displays here as plain "chat" and can be switched back to
 * the LLM chain.
 */
export function ChatModeSelector({
  selectedChain,
  onModeChange,
  defaultOpen,
}: ChatModeSelectorProps) {
  return (
    <DropdownMenu defaultOpen={defaultOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost2" size="fit" className="tw-ml-1 tw-text-sm tw-text-muted">
          {selectedChain === ChainType.LLM_CHAIN ? "chat (free)" : "chat"}
          <ChevronDown className="tw-mt-0.5 tw-size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={() => onModeChange(ChainType.LLM_CHAIN)}>
          chat (free)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
