import * as contextMenuModule from "@/commands/contextMenu";
import { registerContextMenu } from "@/commands/contextMenu";
import { COMMAND_IDS, COMMAND_NAMES } from "@/constants";
import { isDesktopRuntime } from "@/utils/desktopRuntime";
import type { App, Menu } from "obsidian";

jest.mock("@/commands/state", () => ({
  getCachedCustomCommands: jest.fn(() => []),
}));

jest.mock("@/utils/desktopRuntime", () => ({
  isDesktopRuntime: jest.fn(() => false),
}));

class TestMenuItem {
  title = "";
  icon = "";
  submenu: TestMenu | null = null;
  click: (() => void) | null = null;

  setTitle(title: string): TestMenuItem {
    this.title = title;
    return this;
  }

  setIcon(icon: string): TestMenuItem {
    this.icon = icon;
    return this;
  }

  setSubmenu(): TestMenuItem {
    this.submenu = new TestMenu();
    return this;
  }

  onClick(callback: () => void): TestMenuItem {
    this.click = callback;
    return this;
  }
}

class TestMenu {
  readonly items: TestMenuItem[] = [];

  addItem(configure: (item: TestMenuItem) => void): TestMenu {
    const item = new TestMenuItem();
    configure(item);
    this.items.push(item);
    return this;
  }

  addSeparator(): TestMenu {
    return this;
  }
}

function findItem(menu: TestMenu, title: string): TestMenuItem | undefined {
  return menu.items.find((item) => item.title === title);
}

interface AppStub {
  commands: { executeCommandById: jest.Mock };
  workspace: { getActiveFile: jest.Mock };
}

function makeApp(activeFile: unknown): AppStub {
  return {
    commands: { executeCommandById: jest.fn() },
    workspace: { getActiveFile: jest.fn(() => activeFile) },
  };
}

describe("contextMenu", () => {
  beforeEach(() => {
    // Base runtime for the shared tests; the floating-chat tests opt into the
    // desktop runtime explicitly.
    jest.mocked(isDesktopRuntime).mockReturnValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("registerContextMenu()", () => {
    it("omits publishing from the editor context submenu", () => {
      const menu = new TestMenu();
      const app = {
        commands: { executeCommandById: jest.fn() },
        workspace: { getActiveFile: jest.fn(() => null) },
      } as unknown as App;

      registerContextMenu(menu as unknown as Menu, app);

      const copilotMenu = findItem(menu, "Copilot")?.submenu;
      expect(
        findItem(copilotMenu!, COMMAND_NAMES[COMMAND_IDS.PUBLISH_FILE_TO_OPENARTIFACTS])
      ).toBeUndefined();
    });

    it("does not expose a file-menu publishing registration", () => {
      expect(contextMenuModule).not.toHaveProperty("registerOpenArtifactsFileMenu");
    });
  });

  describe("registerContextMenu() / Chat about this note", () => {
    it("offers the item for an active Markdown note and opens the floating chat via the shared command", () => {
      jest.mocked(isDesktopRuntime).mockReturnValue(true);
      const menu = new TestMenu();
      const app = makeApp({ basename: "Deep Dive", extension: "md" });

      registerContextMenu(menu as unknown as Menu, app as unknown as App);

      const copilotMenu = findItem(menu, "Copilot")?.submenu;
      const item = findItem(copilotMenu!, "Chat about this note");
      expect(item).toBeDefined();
      item?.click?.();
      expect(app.commands.executeCommandById).toHaveBeenCalledWith(
        `copilot:${COMMAND_IDS.OPEN_FLOATING_AGENT_CHAT}`
      );
    });

    it("hides the item when no file is active", () => {
      jest.mocked(isDesktopRuntime).mockReturnValue(true);
      const menu = new TestMenu();

      registerContextMenu(menu as unknown as Menu, makeApp(null) as unknown as App);

      const copilotMenu = findItem(menu, "Copilot")?.submenu;
      expect(findItem(copilotMenu!, "Chat about this note")).toBeUndefined();
    });

    it("hides the item when the active file is not Markdown", () => {
      jest.mocked(isDesktopRuntime).mockReturnValue(true);
      const menu = new TestMenu();

      registerContextMenu(
        menu as unknown as Menu,
        makeApp({ basename: "Board", extension: "canvas" }) as unknown as App
      );

      const copilotMenu = findItem(menu, "Copilot")?.submenu;
      expect(findItem(copilotMenu!, "Chat about this note")).toBeUndefined();
    });

    it("hides the item outside the desktop runtime, where the floating chat command does not exist", () => {
      const menu = new TestMenu();

      registerContextMenu(
        menu as unknown as Menu,
        makeApp({ basename: "Deep Dive", extension: "md" }) as unknown as App
      );

      const copilotMenu = findItem(menu, "Copilot")?.submenu;
      expect(findItem(copilotMenu!, "Chat about this note")).toBeUndefined();
    });
  });
});
