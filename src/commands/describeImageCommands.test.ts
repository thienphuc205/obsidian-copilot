import { webcrypto } from "crypto";

import type { LocalImageReader } from "@/context/assets/assetTypes";
import type {
  ImageDescriptionEntry,
  ImageDescriptionIO,
} from "@/context/assets/imageDescriptionStore";
import {
  createDescribeImageCommand,
  describeNoteImages,
  DESCRIPTION_IMAGES_COMMAND_ID,
  DESCRIPTION_IMAGES_COMMAND_NAME,
  IMAGE_DESCRIPTIONS_PATH,
  registerDescribeImageCommands,
} from "@/commands/describeImageCommands";
import { mockTFile } from "@/__tests__/mockObsidian";
import type CopilotPlugin from "@/main";
import { arrayBufferToBase64 } from "@/utils/base64";
import { Notice, type App, type Command, type TFile } from "obsidian";

jest.mock("@/logger", () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

const FIXED_DATE = new Date(Date.UTC(2026, 8, 11, 10, 30, 0));
const FIXED_ISO = FIXED_DATE.toISOString();
const NOTE_PATH = "Notes/Active.md";
const IMAGE_DESCRIPTIONS_DIR = ".copilot";

// Two byte arrays that both match the PNG signature but hash differently.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_ALT_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x2a]);

function pngBytes(seed: number): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed]);
}

function expectedImageBlock(bytes: Uint8Array): unknown {
  return {
    type: "image_url",
    image_url: { url: `data:image/png;base64,${arrayBufferToBase64(bytes.slice().buffer)}` },
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await webcrypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

beforeAll(() => {
  if (!window.crypto?.subtle) {
    Object.defineProperty(window, "crypto", { configurable: true, value: webcrypto });
  }
});

interface ImageFixture {
  /** Embed reference exactly as it appears in the note text. */
  readonly reference: string;
  /** Vault path the fake reader resolves the reference to. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

const WIKI_IMAGE: ImageFixture = {
  reference: "shots/app-a.png",
  path: "assets/shots/app-a.png",
  bytes: PNG_BYTES,
};

const MARKDOWN_IMAGE: ImageFixture = {
  reference: "../shared/app-b.png",
  path: "assets/shared/app-b.png",
  bytes: PNG_ALT_BYTES,
};

// Covers both embed syntaxes. Markdown destinations are extracted before wiki
// embeds, so the parsed reference order is [MARKDOWN_IMAGE, WIKI_IMAGE].
function twoImageNoteText(): string {
  return [
    "Intro text.",
    `![[${WIKI_IMAGE.reference}]]`,
    `![screen capture](${MARKDOWN_IMAGE.reference})`,
  ].join("\n");
}

function wikiNoteText(images: readonly ImageFixture[]): string {
  return images.map((image) => `![[${image.reference}]]`).join("\n");
}

interface DescribeImageHostFixture {
  readonly app: App;
  readonly getActiveFile: jest.Mock;
  readonly getAbstractFileByPath: jest.Mock;
  readonly readNote: jest.Mock;
  readonly files: Map<string, string>;
  readonly adapterExists: jest.Mock;
  readonly adapterRead: jest.Mock;
  readonly adapterWrite: jest.Mock;
  readonly adapterMkdir: jest.Mock;
}

function hostFor(activeFile: TFile | null, noteText: string): DescribeImageHostFixture {
  const files = new Map<string, string>();
  const adapterExists = jest.fn(async (path: string) => files.has(path));
  const adapterRead = jest.fn(async (path: string) => {
    const contents = files.get(path);
    if (contents === undefined) throw new Error(`ENOENT: ${path}`);
    return contents;
  });
  const adapterWrite = jest.fn(async (path: string, contents: string) => {
    files.set(path, contents);
  });
  const adapterMkdir = jest.fn(async () => undefined);
  const readNote = jest.fn().mockResolvedValue(noteText);
  const getActiveFile = jest.fn(() => activeFile);
  const getAbstractFileByPath = jest.fn((path: string) =>
    activeFile && path === activeFile.path ? activeFile : null
  );
  const vault = {
    read: readNote,
    getAbstractFileByPath,
    adapter: { exists: adapterExists, read: adapterRead, write: adapterWrite, mkdir: adapterMkdir },
  };
  const app = { workspace: { getActiveFile }, vault } as unknown as App;
  return {
    app,
    getActiveFile,
    getAbstractFileByPath,
    readNote,
    files,
    adapterExists,
    adapterRead,
    adapterWrite,
    adapterMkdir,
  };
}

function activeNote(): TFile {
  return mockTFile({ path: NOTE_PATH, extension: "md", stat: { size: 128, mtime: 1, ctime: 1 } });
}

interface DescribeImageReaderFixture {
  readonly reader: LocalImageReader;
  readonly readBinary: jest.Mock;
}

function readerFor(images: readonly ImageFixture[]): DescribeImageReaderFixture {
  const fileByReference = new Map<string, TFile>(
    images.map((image) => [
      image.reference,
      mockTFile({
        path: image.path,
        extension: "png",
        stat: { size: image.bytes.byteLength, mtime: 1, ctime: 1 },
      }),
    ])
  );
  const bytesByPath = new Map(images.map((image) => [image.path, image.bytes]));
  const resolveLink = jest.fn((reference: string) => fileByReference.get(reference) ?? null);
  const readBinary = jest.fn(async (file: TFile) => {
    const bytes = bytesByPath.get(file.path);
    if (!bytes) throw new Error(`No fake bytes for ${file.path}`);
    return bytes.slice().buffer;
  });
  const reader: LocalImageReader = {
    resolveLink,
    readBinary,
    authorizeResolvedFile: jest.fn(() => true),
    getVaultId: () => "vault-test",
  };
  return { reader, readBinary };
}

function memoryIO(): { writes: string[]; io: ImageDescriptionIO } {
  const writes: string[] = [];
  const io: ImageDescriptionIO = {
    readFile: async () => null,
    writeFile: async (contents) => {
      writes.push(contents);
    },
  };
  return { writes, io };
}

function pluginFor(app: App, addCommand: jest.Mock = jest.fn()): CopilotPlugin {
  return { app, addCommand } as unknown as CopilotPlugin;
}

function commandFor(
  host: DescribeImageHostFixture,
  options: {
    readonly reader: LocalImageReader;
    readonly describeImage: (content: unknown) => Promise<unknown>;
    readonly now?: () => Date;
    readonly io?: ImageDescriptionIO;
  }
): Command {
  return createDescribeImageCommand(pluginFor(host.app), {
    now: options.now ?? (() => FIXED_DATE),
    describeImage: options.describeImage,
    createReader: () => options.reader,
    ...(options.io ? { io: options.io } : {}),
  });
}

function storedEntries(host: DescribeImageHostFixture): ImageDescriptionEntry[] {
  const raw = host.files.get(IMAGE_DESCRIPTIONS_PATH);
  expect(raw).toBeDefined();
  return (JSON.parse(raw as string) as { entries: ImageDescriptionEntry[] }).entries;
}

describe("describeImageCommands", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("registerDescribeImageCommands()", () => {
    it("registers one command with the exported id and name, and the callback guards on an open note", async () => {
      const host = hostFor(null, "");
      const addCommand = jest.fn();
      registerDescribeImageCommands(pluginFor(host.app, addCommand));

      expect(addCommand).toHaveBeenCalledTimes(1);
      const [command] = addCommand.mock.calls[0] as [Command];
      expect(command).toMatchObject({
        id: DESCRIPTION_IMAGES_COMMAND_ID,
        name: DESCRIPTION_IMAGES_COMMAND_NAME,
      });

      await command.callback?.();

      expect(host.readNote).not.toHaveBeenCalled();
      expect(Notice).toHaveBeenCalledWith("Open a note first.");
    });
  });

  describe("createDescribeImageCommand()", () => {
    it("notifies to open a note first without reading anything when no file is active", async () => {
      const host = hostFor(null, "");
      const { reader } = readerFor([]);
      const describeImage = jest.fn();
      const command = commandFor(host, { reader, describeImage });

      await command.callback?.();

      expect(host.readNote).not.toHaveBeenCalled();
      expect(host.adapterWrite).not.toHaveBeenCalled();
      expect(describeImage).not.toHaveBeenCalled();
      expect(Notice).toHaveBeenCalledTimes(1);
      expect(Notice).toHaveBeenCalledWith("Open a note first.");
    });

    it("notifies to open a note first for a non-Markdown active file", async () => {
      const canvasFile = mockTFile({
        path: "Scratch.canvas",
        extension: "canvas",
        stat: { size: 32, mtime: 1, ctime: 1 },
      });
      const host = hostFor(canvasFile, "");
      const { reader } = readerFor([]);
      const describeImage = jest.fn();
      const command = commandFor(host, { reader, describeImage });

      await command.callback?.();

      expect(host.readNote).not.toHaveBeenCalled();
      expect(host.adapterWrite).not.toHaveBeenCalled();
      expect(describeImage).not.toHaveBeenCalled();
      expect(Notice).toHaveBeenCalledWith("Open a note first.");
    });

    it("describes each embedded image with the exact data-URL block and stores bounded entries", async () => {
      const host = hostFor(activeNote(), twoImageNoteText());
      const { reader } = readerFor([WIKI_IMAGE, MARKDOWN_IMAGE]);
      const describeImage = jest
        .fn()
        .mockResolvedValueOnce("A chart of monthly revenue")
        .mockResolvedValueOnce("A screenshot of a settings panel");
      const command = commandFor(host, { reader, describeImage });

      await command.callback?.();

      expect(describeImage).toHaveBeenCalledTimes(2);
      expect(describeImage).toHaveBeenNthCalledWith(1, expectedImageBlock(PNG_ALT_BYTES));
      expect(describeImage).toHaveBeenNthCalledWith(2, expectedImageBlock(PNG_BYTES));
      expect(host.adapterMkdir).toHaveBeenCalledWith(IMAGE_DESCRIPTIONS_DIR);
      expect(host.adapterWrite).toHaveBeenCalledWith(IMAGE_DESCRIPTIONS_PATH, expect.any(String));
      expect(storedEntries(host)).toEqual([
        {
          digest: await sha256Hex(PNG_ALT_BYTES),
          description: "A chart of monthly revenue",
          vaultPath: "assets/shared/app-b.png",
          updatedAt: FIXED_ISO,
        },
        {
          digest: await sha256Hex(PNG_BYTES),
          description: "A screenshot of a settings panel",
          vaultPath: "assets/shots/app-a.png",
          updatedAt: FIXED_ISO,
        },
      ]);
      expect(Notice).toHaveBeenCalledWith("Described 2, skipped 0, failed 0 (of 2)");
    });

    it("skips a digest that is already stored and describes only the new image", async () => {
      const host = hostFor(activeNote(), twoImageNoteText());
      host.files.set(
        IMAGE_DESCRIPTIONS_PATH,
        JSON.stringify({
          version: 1,
          entries: [
            {
              digest: await sha256Hex(PNG_ALT_BYTES),
              description: "prestored description",
              updatedAt: FIXED_ISO,
            },
          ],
        })
      );
      const { reader } = readerFor([WIKI_IMAGE, MARKDOWN_IMAGE]);
      const describeImage = jest.fn().mockResolvedValue("new description");
      const command = commandFor(host, { reader, describeImage });

      await command.callback?.();

      expect(describeImage).toHaveBeenCalledTimes(1);
      expect(describeImage).toHaveBeenCalledWith(expectedImageBlock(PNG_BYTES));
      const entries = storedEntries(host);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ description: "prestored description" });
      expect(entries[1]).toMatchObject({
        digest: await sha256Hex(PNG_BYTES),
        description: "new description",
        vaultPath: "assets/shots/app-a.png",
        updatedAt: FIXED_ISO,
      });
      expect(Notice).toHaveBeenCalledWith("Described 1, skipped 1, failed 0 (of 2)");
    });

    it("counts a repeat run of the same note as digest dedup skips", async () => {
      const host = hostFor(activeNote(), twoImageNoteText());
      const { reader } = readerFor([WIKI_IMAGE, MARKDOWN_IMAGE]);
      const describeImage = jest.fn().mockResolvedValue("a description");
      const command = commandFor(host, { reader, describeImage });

      await command.callback?.();
      expect(Notice).toHaveBeenLastCalledWith("Described 2, skipped 0, failed 0 (of 2)");

      await command.callback?.();

      expect(describeImage).toHaveBeenCalledTimes(2);
      expect(Notice).toHaveBeenLastCalledWith("Described 0, skipped 2, failed 0 (of 2)");
    });

    it("continues after a per-image describer failure and counts it as failed", async () => {
      const host = hostFor(activeNote(), twoImageNoteText());
      const { reader } = readerFor([WIKI_IMAGE, MARKDOWN_IMAGE]);
      const describeImage = jest
        .fn()
        .mockRejectedValueOnce(new Error("provider outage"))
        .mockResolvedValueOnce("A screenshot of a settings panel");
      const command = commandFor(host, { reader, describeImage });

      await command.callback?.();

      expect(describeImage).toHaveBeenCalledTimes(2);
      const entries = storedEntries(host);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        digest: await sha256Hex(PNG_BYTES),
        description: "A screenshot of a settings panel",
        vaultPath: "assets/shots/app-a.png",
        updatedAt: FIXED_ISO,
      });
      expect(Notice).toHaveBeenCalledWith("Described 1, skipped 0, failed 1 (of 2)");
    });

    it("notifies the failure reason without a success summary when every new image fails", async () => {
      const host = hostFor(activeNote(), twoImageNoteText());
      const { reader } = readerFor([WIKI_IMAGE, MARKDOWN_IMAGE]);
      const describeImage = jest.fn(async () => {
        throw new Error("model offline");
      });
      const command = commandFor(host, { reader, describeImage });

      await command.callback?.();

      expect(describeImage).toHaveBeenCalledTimes(2);
      expect(host.files.get(IMAGE_DESCRIPTIONS_PATH)).toBeUndefined();
      expect(Notice).toHaveBeenCalledWith(
        expect.stringContaining("new images failed: model offline")
      );
      expect(Notice).not.toHaveBeenCalledWith(expect.stringContaining("Described"));
    });

    it("processes only the first 20 embedded images and reports the cap in the final notice", async () => {
      const images = Array.from({ length: 22 }, (_, index) => ({
        reference: `shots/app-${index + 1}.png`,
        path: `assets/app-${index + 1}.png`,
        bytes: pngBytes(index + 1),
      }));
      const host = hostFor(activeNote(), wikiNoteText(images));
      const { reader } = readerFor(images);
      const { writes, io } = memoryIO();
      const describeImage = jest.fn().mockResolvedValue("a description");
      const command = commandFor(host, { reader, describeImage, io });

      await command.callback?.();

      expect(describeImage).toHaveBeenCalledTimes(20);
      expect(writes).toHaveLength(20);
      expect(Notice).toHaveBeenCalledWith(
        "Described 20, skipped 0, failed 0 (of 20). Only the first 20 of 22 images were processed."
      );
    });

    it("counts a store write failure as a failed image and does not claim success", async () => {
      const host = hostFor(activeNote(), twoImageNoteText());
      const { reader } = readerFor([WIKI_IMAGE, MARKDOWN_IMAGE]);
      let writeCalls = 0;
      const writeFile = async (): Promise<void> => {
        writeCalls += 1;
        throw new Error("disk full");
      };
      const describeImage = jest.fn().mockResolvedValue("a description");
      const command = commandFor(host, {
        reader,
        describeImage,
        io: { readFile: async () => null, writeFile },
      });

      await command.callback?.();

      expect(describeImage).toHaveBeenCalledTimes(2);
      expect(writeCalls).toBe(2);
      expect(Notice).toHaveBeenCalledWith(
        expect.stringContaining("Image description store write failed")
      );
      expect(Notice).not.toHaveBeenCalledWith(expect.stringContaining("Described"));
    });
  });

  describe("describeNoteImages()", () => {
    it("describes the given note in quiet mode, stores entries, and fires no Notice", async () => {
      const host = hostFor(activeNote(), twoImageNoteText());
      const { reader } = readerFor([WIKI_IMAGE, MARKDOWN_IMAGE]);
      const describeImage = jest.fn().mockResolvedValue("A chart of monthly revenue");

      const result = await describeNoteImages(pluginFor(host.app), NOTE_PATH, {
        now: () => FIXED_DATE,
        describeImage,
        createReader: () => reader,
        quiet: true,
      });

      expect(result).toBe("described");
      expect(describeImage).toHaveBeenCalledTimes(2);
      expect(storedEntries(host)).toHaveLength(2);
      expect(Notice).not.toHaveBeenCalled();
    });

    it("skips quietly when the note has no embedded images", async () => {
      const host = hostFor(activeNote(), "Plain text only.");
      const { reader } = readerFor([]);
      const describeImage = jest.fn();

      const result = await describeNoteImages(pluginFor(host.app), NOTE_PATH, {
        describeImage,
        createReader: () => reader,
        quiet: true,
      });

      expect(result).toBe("skipped");
      expect(describeImage).not.toHaveBeenCalled();
      expect(Notice).not.toHaveBeenCalled();
    });

    it("skips quietly when the note path no longer resolves to a Markdown file", async () => {
      const host = hostFor(activeNote(), twoImageNoteText());
      const { reader } = readerFor([]);
      const describeImage = jest.fn();

      const result = await describeNoteImages(pluginFor(host.app), "Notes/Gone.md", {
        describeImage,
        createReader: () => reader,
        quiet: true,
      });

      expect(result).toBe("skipped");
      expect(host.readNote).not.toHaveBeenCalled();
      expect(Notice).not.toHaveBeenCalled();
    });

    it("reports failure without a Notice in quiet mode when every new image fails", async () => {
      const host = hostFor(activeNote(), twoImageNoteText());
      const { reader } = readerFor([WIKI_IMAGE, MARKDOWN_IMAGE]);
      const describeImage = jest.fn(async () => {
        throw new Error("model offline");
      });

      const result = await describeNoteImages(pluginFor(host.app), NOTE_PATH, {
        describeImage,
        createReader: () => reader,
        quiet: true,
      });

      expect(result).toBe("failed");
      expect(describeImage).toHaveBeenCalledTimes(2);
      expect(host.files.get(IMAGE_DESCRIPTIONS_PATH)).toBeUndefined();
      expect(Notice).not.toHaveBeenCalled();
    });

    it("returns skipped for a fully stored note and failed for an outer run error", async () => {
      const host = hostFor(activeNote(), twoImageNoteText());
      host.files.set(
        IMAGE_DESCRIPTIONS_PATH,
        JSON.stringify({
          version: 1,
          entries: [
            {
              digest: await sha256Hex(PNG_ALT_BYTES),
              description: "prestored description",
              updatedAt: FIXED_ISO,
            },
            {
              digest: await sha256Hex(PNG_BYTES),
              description: "prestored description",
              updatedAt: FIXED_ISO,
            },
          ],
        })
      );
      const { reader } = readerFor([WIKI_IMAGE, MARKDOWN_IMAGE]);
      const describeImage = jest.fn();
      const quietPlugin = pluginFor(host.app);

      await expect(
        describeNoteImages(quietPlugin, NOTE_PATH, {
          describeImage,
          createReader: () => reader,
          quiet: true,
        })
      ).resolves.toBe("skipped");

      await expect(
        describeNoteImages(quietPlugin, NOTE_PATH, {
          describeImage,
          createReader: () => reader,
          io: {
            readFile: async () => null,
            writeFile: async () => {
              throw new Error("disk full");
            },
          },
          quiet: true,
        })
      ).resolves.toBe("failed");
      expect(Notice).not.toHaveBeenCalled();
    });
  });
});
