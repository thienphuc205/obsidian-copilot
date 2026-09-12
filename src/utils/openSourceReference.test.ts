import { mockTFile } from "@/__tests__/mockObsidian";
import type { SourceReference } from "@/context/sourceReferences";
import { openFileInWorkspace } from "@/utils";
import { App, Notice } from "obsidian";
import { openSourceReference } from "./openSourceReference";

jest.mock("@/utils", () => ({
  openFileInWorkspace: jest.fn().mockResolvedValue(undefined),
}));

const mockOpenFileInWorkspace = openFileInWorkspace as jest.MockedFunction<
  typeof openFileInWorkspace
>;

const source = (overrides: Partial<SourceReference> = {}): SourceReference => ({
  title: "Paper",
  path: "Research/paper.md",
  score: 0.9,
  ...overrides,
});

describe("openSourceReference", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(window, "open").mockReturnValue({} as Window);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("opens web sources externally without sending them to Obsidian link resolution", async () => {
    const app = {} as App;

    await expect(
      openSourceReference(app, source({ path: "https://example.com/paper" }))
    ).resolves.toBe(true);

    expect(window.open).toHaveBeenCalledWith(
      "https://example.com/paper",
      "_blank",
      "noopener,noreferrer"
    );
    expect(mockOpenFileInWorkspace).not.toHaveBeenCalled();
  });

  it("requires the source file to exist in the current vault before opening it", async () => {
    const openLinkText = jest.fn().mockResolvedValue(undefined);
    const app = {
      vault: { getAbstractFileByPath: jest.fn().mockReturnValue(null) },
      workspace: { openLinkText },
    } as unknown as App;

    await expect(openSourceReference(app, source())).resolves.toBe(false);

    expect(openLinkText).not.toHaveBeenCalled();
    expect(mockOpenFileInWorkspace).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith("This source is no longer available in the current vault.");
  });

  it("routes page sources through an Obsidian page anchor", async () => {
    const file = mockTFile({ path: "Research/paper.pdf" });
    const openLinkText = jest.fn().mockResolvedValue(undefined);
    const app = {
      vault: { getAbstractFileByPath: jest.fn().mockReturnValue(file) },
      workspace: { openLinkText },
    } as unknown as App;

    await expect(
      openSourceReference(app, source({ path: "Research/paper.pdf", page: 4 }))
    ).resolves.toBe(true);

    expect(openLinkText).toHaveBeenCalledWith("Research/paper.pdf#page=4", "", false);
    expect(mockOpenFileInWorkspace).not.toHaveBeenCalled();
  });

  it("opens a line source and positions a Markdown editor at the requested line", async () => {
    const file = mockTFile({ path: "Research/paper.md" });
    const setCursor = jest.fn();
    const openFile = jest.fn().mockImplementation(async () => undefined);
    const app = {
      vault: { getAbstractFileByPath: jest.fn().mockReturnValue(file) },
      workspace: {
        getLeaf: jest.fn().mockReturnValue({
          openFile,
          view: { file, editor: { setCursor } },
        }),
      },
    } as unknown as App;

    await expect(openSourceReference(app, source({ line: 7 }))).resolves.toBe(true);

    expect(openFile).toHaveBeenCalledWith(file);
    expect(setCursor).toHaveBeenCalledWith({ line: 6, ch: 0 });
  });

  it("does not hand malformed vault references to the workspace", async () => {
    const openLinkText = jest.fn().mockResolvedValue(undefined);
    const app = {
      vault: { getAbstractFileByPath: jest.fn() },
      workspace: { openLinkText },
    } as unknown as App;

    await expect(openSourceReference(app, source({ path: "../../secret.md" }))).resolves.toBe(
      false
    );

    expect(openLinkText).not.toHaveBeenCalled();
    expect(app.vault.getAbstractFileByPath).not.toHaveBeenCalled();
    expect(Notice).toHaveBeenCalledWith("This source is unavailable or has an invalid reference.");
  });
});
