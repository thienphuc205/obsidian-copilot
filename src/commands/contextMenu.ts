import { getCommandId, sortCommandsByOrder } from "@/commands/customCommandUtils";
import { getCachedCustomCommands } from "@/commands/state";
import { COMMAND_IDS } from "@/constants";
import type { App, Menu } from "obsidian";
import { isDesktopRuntime } from "@/utils/desktopRuntime";
import type { CustomCommand } from "./type";

interface CommandManager {
  executeCommandById: (commandId: string) => boolean;
}

interface AppWithCommands extends App {
  commands: CommandManager;
}

/**
 * Type guard for the command manager surface used by Copilot.
 */
function hasCommandManager(app: App): app is AppWithCommands {
  return typeof (app as Partial<AppWithCommands>).commands?.executeCommandById === "function";
}

/**
 * Registers the Copilot submenu entries in Obsidian's editor context menu.
 */
export function registerContextMenu(menu: Menu, obsidianApp: App): void {
  if (!hasCommandManager(obsidianApp)) return;

  const execute = (commandId: string): void => {
    obsidianApp.commands.executeCommandById(commandId);
  };

  // Create the main "Copilot" submenu
  menu.addItem((item) => {
    item.setTitle("Copilot");
    item.setSubmenu();

    const submenu = item.submenu;
    if (!submenu) return;

    // Add the main selection command
    submenu.addItem((subItem) => {
      subItem.setTitle("Add selection to chat context").onClick(() => {
        execute(`copilot:${COMMAND_IDS.ADD_SELECTION_TO_CHAT_CONTEXT}`);
      });
    });

    submenu.addItem((subItem) => {
      subItem.setTitle("Quick Ask").onClick(() => {
        execute(`copilot:${COMMAND_IDS.TRIGGER_QUICK_ASK}`);
      });
    });

    submenu.addItem((subItem) => {
      subItem.setTitle("Trigger quick command").onClick(() => {
        execute(`copilot:${COMMAND_IDS.TRIGGER_QUICK_COMMAND}`);
      });
    });

    // "Chat about this note" opens the floating agent chat popup with the
    // active note preloaded into the prompt. It executes the shared command
    // (same entry point as the palette) so the prefill logic lives in one
    // place, and is offered only when a Markdown note is active — the prompt
    // is built from that note. Desktop-gated like the command itself, which
    // only exists where the Agent Mode runtime does.
    if (isDesktopRuntime()) {
      const activeFile = obsidianApp.workspace.getActiveFile();
      if (activeFile?.extension === "md") {
        submenu.addItem((subItem) => {
          subItem.setTitle("Chat about this note").onClick(() => {
            execute(`copilot:${COMMAND_IDS.OPEN_FLOATING_AGENT_CHAT}`);
          });
        });
      }
    }

    // Get custom commands
    const commands = getCachedCustomCommands();
    const visibleCustomCommands = commands.filter(
      (command: CustomCommand) => command.showInContextMenu
    );

    // Add separator if there are custom commands
    if (visibleCustomCommands.length > 0) {
      submenu.addSeparator();
    }

    // Add custom commands to submenu
    sortCommandsByOrder(visibleCustomCommands).forEach((command: CustomCommand) => {
      submenu.addItem((subItem) => {
        subItem.setTitle(command.title).onClick(() => {
          execute(`copilot:${getCommandId(command.title)}`);
        });
      });
    });
  });
}
