import { ContextProcessor } from "@/contextProcessor";
import type { FileParserManager } from "@/tools/FileParserManager";
import { EMBEDDED_NOTE_TAG } from "@/constants";
import type { SourceReference } from "@/context/sourceReferences";
import { TFile, Vault } from "obsidian";

// FileParserManager (a type-only import here, but the runtime chain through the
// context processor still pulls "@/utils"); the real module is out of this
// suite's scope, so stub the functions the reachable paths need at require time.
jest.mock("@/utils", () => ({
  err2String: (error: unknown) => String(error),
  withTimeout: <T>(promise: Promise<T>) => promise,
  ensureFolderExists: jest.fn(async () => undefined),
}));

type FileCacheMap = Record<string, unknown>;
type FileContentMap = Record<string, string>;

const createMockFile = (path: string): TFile =>
  new (TFile as unknown as new (path: string) => TFile)(path);

describe("ContextProcessor - Embedded Notes", () => {
  let contextProcessor: ContextProcessor;
  let vault: Vault;
  let fileParserManager: unknown;
  let fileCaches: FileCacheMap;
  let fileContents: FileContentMap;
  let fileIndex: Map<string, TFile>;

  beforeEach(() => {
    fileCaches = {};
    fileContents = {};
    fileIndex = new Map<string, TFile>();

    const metadataCacheMock = {
      getFirstLinkpathDest: jest.fn((link: string, _sourcePath: string) => {
        const normalized = link.endsWith(".md") ? link : `${link}.md`;
        return fileIndex.get(normalized) ?? null;
      }),
      getFileCache: jest.fn((file: TFile) => fileCaches[file.path] ?? {}),
    };

    (window as unknown as Record<string, unknown>).app = {
      metadataCache: metadataCacheMock,
    };

    contextProcessor = ContextProcessor.getInstance(window.app);

    vault = {
      adapter: {
        stat: jest.fn().mockResolvedValue({ ctime: 0, mtime: 0 }),
      },
    } as unknown as Vault;

    (vault as Vault & Record<string, unknown>).getAbstractFileByPath = jest.fn();

    fileParserManager = {
      supportsExtension: jest.fn(
        (extension: string) => extension === "md" || extension === "canvas"
      ),
      parseFile: jest.fn(async (file: TFile) => {
        const content = fileContents[file.path];
        if (content === undefined) {
          throw new Error(`Missing mock content for ${file.path}`);
        }
        return content;
      }),
    };
  });

  const registerFile = (file: TFile, content: string, cache: unknown = {}): void => {
    fileIndex.set(file.path, file);
    fileContents[file.path] = content;
    fileCaches[file.path] = cache;
  };

  it("should include embedded note content in the context payload", async () => {
    const source = createMockFile("Source.md");
    const embedded = createMockFile("Embedded.md");

    registerFile(source, "Introduction\n![[Embedded]]\nConclusion");
    registerFile(embedded, "Embedded note body");

    const result = await contextProcessor.processContextNotes(
      new Set(),
      fileParserManager as FileParserManager,
      vault,
      [source],
      false,
      null
    );

    expect(result).toContain(`<${EMBEDDED_NOTE_TAG}>`);
    expect(result).toContain("Embedded note body");
  });

  it("should extract a heading section when the embedded note targets a heading", async () => {
    const source = createMockFile("Source.md");
    const embedded = createMockFile("Embedded.md");
    const embeddedContent = "## Section\nImportant details\n\n## Other\nOther details";

    registerFile(source, "Root\n![[Embedded#Section]]\nTail");
    registerFile(embedded, embeddedContent, {
      headings: [
        {
          heading: "Section",
          level: 2,
          position: { start: { offset: 0 } },
        },
        {
          heading: "Other",
          level: 2,
          position: { start: { offset: embeddedContent.indexOf("## Other") } },
        },
      ],
    });

    const result = await contextProcessor.processContextNotes(
      new Set(),
      fileParserManager as FileParserManager,
      vault,
      [source],
      false,
      null
    );

    expect(result).toContain("<heading>Section</heading>");
    expect(result).toContain("Important details");
    expect(result).not.toContain("Other details");
  });

  it("should extract block reference content when embedding a block", async () => {
    const source = createMockFile("Source.md");
    const embedded = createMockFile("Embedded.md");
    const embeddedContent = "Paragraph 1\nParagraph 2 ^block-ref\nParagraph 3\n";
    const blockStart = embeddedContent.indexOf("Paragraph 2");
    const blockEnd = embeddedContent.indexOf("Paragraph 3");

    registerFile(source, "![[Embedded#^block-ref]]");
    registerFile(embedded, embeddedContent, {
      blocks: {
        "block-ref": {
          position: {
            start: { offset: blockStart },
            end: { offset: blockEnd },
          },
        },
      },
    });

    const result = await contextProcessor.processContextNotes(
      new Set(),
      fileParserManager as FileParserManager,
      vault,
      [source],
      false,
      null
    );

    expect(result).toContain("<block_id>block-ref</block_id>");
    expect(result).toContain("Paragraph 2 ^block-ref");
    expect(result).not.toContain("Paragraph 3");
  });

  it("should leave nested embeds untouched for recursive references", async () => {
    const source = createMockFile("Source.md");
    const embedded = createMockFile("Embedded.md");

    registerFile(source, "Parent\n![[Embedded]]", {});
    registerFile(embedded, "Child\n![[Source]]", {});

    const result = await contextProcessor.processContextNotes(
      new Set(),
      fileParserManager as FileParserManager,
      vault,
      [source],
      false,
      null
    );

    expect(result).toContain("<content>");
    expect(result).toContain("![[Source]]");
  });

  it("should surface an error when the embedded note cannot be resolved", async () => {
    const source = createMockFile("Source.md");

    registerFile(source, "Missing\n![[Absent]]", {});

    const result = await contextProcessor.processContextNotes(
      new Set(),
      fileParserManager as FileParserManager,
      vault,
      [source],
      false,
      null
    );

    expect(result).toContain("<error>Embedded note not found</error>");
  });

  describe("PDF context sources", () => {
    it("uses the source-aware parser once and forwards its page sources", async () => {
      const pdf = createMockFile("Paper.pdf");
      const pageSource: SourceReference = {
        title: "Paper.pdf — page 2",
        path: pdf.path,
        score: 0,
        page: 2,
      };
      const parser = fileParserManager as {
        supportsExtension: jest.Mock;
        parseFile: jest.Mock;
        parseFileWithSources?: jest.Mock;
      };
      parser.supportsExtension.mockReturnValue(true);
      parser.parseFileWithSources = jest.fn().mockResolvedValue({
        content: "PDF page text",
        sources: [pageSource],
      });
      const onSources = jest.fn();

      const result = await contextProcessor.processContextNotes(
        new Set(),
        fileParserManager as FileParserManager,
        vault,
        [pdf],
        false,
        null,
        onSources
      );

      expect(result).toContain("PDF page text");
      expect(parser.parseFileWithSources).toHaveBeenCalledTimes(1);
      expect(parser.parseFileWithSources).toHaveBeenCalledWith(pdf, vault);
      expect(parser.parseFile).not.toHaveBeenCalled();
      expect(onSources).toHaveBeenCalledWith([pageSource]);
    });

    it("keeps legacy PDF parsing text-only without fabricating sources", async () => {
      const pdf = createMockFile("Legacy.pdf");
      registerFile(pdf, "Legacy PDF text");
      const parser = fileParserManager as {
        supportsExtension: jest.Mock;
        parseFile: jest.Mock;
        parseFileWithSources?: jest.Mock;
      };
      parser.supportsExtension.mockReturnValue(true);
      const onSources = jest.fn();

      const result = await contextProcessor.processContextNotes(
        new Set(),
        fileParserManager as FileParserManager,
        vault,
        [pdf],
        false,
        null,
        onSources
      );

      expect(result).toContain("Legacy PDF text");
      expect(parser.parseFile).toHaveBeenCalledWith(pdf, vault);
      expect(onSources).not.toHaveBeenCalled();
    });

    it("does not forward page sources when source-aware PDF parsing fails", async () => {
      const pdf = createMockFile("Broken.pdf");
      const parser = fileParserManager as {
        supportsExtension: jest.Mock;
        parseFile: jest.Mock;
        parseFileWithSources?: jest.Mock;
      };
      parser.supportsExtension.mockReturnValue(true);
      parser.parseFileWithSources = jest.fn().mockRejectedValue(new Error("parse failed"));
      const onSources = jest.fn();

      const result = await contextProcessor.processContextNotes(
        new Set(),
        fileParserManager as FileParserManager,
        vault,
        [pdf],
        false,
        null,
        onSources
      );

      expect(result).toContain("<note_context_error>");
      expect(parser.parseFileWithSources).toHaveBeenCalledTimes(1);
      expect(parser.parseFile).not.toHaveBeenCalled();
      expect(onSources).not.toHaveBeenCalled();
    });
  });
});
