type DesktopRuntimeModule = typeof import("@/utils/desktopRuntime");

jest.mock("@/utils/desktopRuntime", () => {
  const actual = jest.requireActual<DesktopRuntimeModule>("@/utils/desktopRuntime");
  return {
    ...actual,
    isDesktopRuntime: jest.fn(() => true),
    requireNodeModule: jest.fn(actual.requireNodeModule),
  };
});

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { webcrypto } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { FileSystemAdapter, type App, type TFile, type Vault } from "obsidian";

import { mockTFile } from "@/__tests__/mockObsidian";
import { ATTACHMENT_REFERENCE_ENVELOPE_SCHEMA_VERSION } from "@/context/assets/authorizedAttachmentRestore";
import {
  createLocalImageRuntime,
  LOCAL_IMAGE_RUNTIME_MAX_INPUTS,
  type LocalImageRuntime,
  type LocalImageRuntimeLiveScope,
} from "@/context/assets/localImageRuntime";
import { requireNodeModule } from "@/utils/desktopRuntime";

const FileSystemAdapterMock = FileSystemAdapter as unknown as new (
  basePath: string
) => FileSystemAdapter;

const NOTE_PATH = "Notes/reading.md";
const IMAGE_PATH = "Notes/assets/diagram.png";
const NOTE_TEXT = "# Reading\n\n![[assets/diagram.png]]\n";
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c,
  0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64, 0xf8, 0x0f, 0x00,
  0x01, 0x05, 0x01, 0x01, 0x27, 0x18, 0xe3, 0x66, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

interface MutableLiveScope extends LocalImageRuntimeLiveScope {
  vaultId: string;
  notePath: string | null;
  scopePath: string;
}

interface Fixture {
  readonly parent: string;
  readonly homeDir: string;
  readonly vaultRoot: string;
  readonly app: App;
  readonly vault: Vault;
  readonly live: MutableLiveScope;
  readonly noteFile: TFile;
  readonly imageFile: TFile;
  readonly read: jest.Mock<Promise<string>, [TFile]>;
  readonly readBinary: jest.Mock<Promise<ArrayBuffer>, [TFile]>;
  readonly resolveLink: jest.Mock<TFile | null, [string, string]>;
  setNoteText(text: string): void;
}

let fixture: Fixture;

beforeAll(() => {
  if (!window.crypto?.subtle) {
    Object.defineProperty(window, "crypto", {
      configurable: true,
      value: webcrypto,
    });
  }
});

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  rmSync(fixture.parent, { recursive: true, force: true });
  jest.clearAllMocks();
});

describe("localImageRuntime", () => {
  it("previews only bounded note syntax and does not read images or create storage", async () => {
    const runtime = runtimeFor(fixture);

    const preview = await runtime.preview(selection());

    expect(preview.notePath).toBe(NOTE_PATH);
    expect(preview.scopePath).toBe("Notes");
    expect(preview.candidates).toEqual([{ reference: "assets/diagram.png", syntax: "wiki" }]);
    expect(preview.candidateCount).toBe(1);
    expect(preview.truncated).toBe(false);
    expect(preview.maxInputs).toBe(LOCAL_IMAGE_RUNTIME_MAX_INPUTS);
    expect(preview.storageRoot).toContain(join(fixture.homeDir, ".obsidian-copilot"));
    expect(existsSync(preview.storageRoot)).toBe(false);
    expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.readBinary).not.toHaveBeenCalled();
  });

  it("requires confirmation, composes the real reader/store, deduplicates clicks, and reloads restore", async () => {
    const runtime = runtimeFor(fixture);
    const preview = await runtime.preview(selection());

    await expect(
      runtime.execute({
        confirmation: { previewId: preview.previewId, confirmationToken: "forged" },
      })
    ).rejects.toMatchObject({ code: "confirmation-required" });
    expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.readBinary).not.toHaveBeenCalled();
    expect(existsSync(preview.storageRoot)).toBe(false);

    const confirmation = runtime.issueConfirmation(preview.previewId);
    const first = runtime.execute({ confirmation });
    const second = runtime.execute({ confirmation });

    expect(second).toBe(first);
    const result = await first;
    expect(result.persistedCount).toBe(1);
    expect(result.persisted).toHaveLength(1);
    expect(fixture.read).toHaveBeenCalledTimes(1);
    expect(fixture.readBinary).toHaveBeenCalledTimes(1);
    expect(existsSync(preview.storageRoot)).toBe(true);

    expect(() => runtime.issueConfirmation(preview.previewId)).toThrow("no longer current");
    const attachment = result.persisted[0];
    expect(attachment).toBeDefined();
    if (!attachment) throw new Error("Expected one persisted attachment");
    await expect(
      runtime.restore({
        schemaVersion: ATTACHMENT_REFERENCE_ENVELOPE_SCHEMA_VERSION,
        vaultId: "stable-vault-id",
        attachmentId: attachment.attachmentId,
      })
    ).resolves.toEqual(PNG_BYTES.buffer);
    expect(fixture.readBinary).toHaveBeenCalledTimes(1);

    const reloadedRuntime = runtimeFor(fixture);
    await expect(
      reloadedRuntime.restore({
        schemaVersion: ATTACHMENT_REFERENCE_ENVELOPE_SCHEMA_VERSION,
        vaultId: "stable-vault-id",
        attachmentId: attachment.attachmentId,
      })
    ).resolves.toEqual(PNG_BYTES.buffer);
  });

  it("rechecks live restore scope before returning bytes after revocation", async () => {
    mkdirSync(join(fixture.vaultRoot, "Other"));
    const writer = runtimeFor(fixture);
    const preview = await writer.preview(selection());
    const confirmation = writer.issueConfirmation(preview.previewId);
    const result = await writer.execute({ confirmation });
    const attachment = result.persisted[0];
    expect(attachment).toBeDefined();
    if (!attachment) throw new Error("Expected one persisted attachment");

    let restoreCalls = 0;
    const restoreGetter = jest.fn(async () => {
      restoreCalls += 1;
      const snapshot = { ...fixture.live };
      if (restoreCalls === 2) fixture.live.scopePath = "Other";
      return snapshot;
    });
    const reader = runtimeFor(fixture, restoreGetter);

    await expect(
      reader.restore({
        schemaVersion: ATTACHMENT_REFERENCE_ENVELOPE_SCHEMA_VERSION,
        vaultId: "stable-vault-id",
        attachmentId: attachment.attachmentId,
      })
    ).rejects.toMatchObject({ code: "authorization-denied" });
    expect(restoreCalls).toBeGreaterThanOrEqual(3);
    expect(fixture.readBinary).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to whole-vault access when the authoritative scope fails", async () => {
    const getter = jest.fn().mockRejectedValue(new Error("scope unavailable"));
    const runtime = runtimeFor(fixture, getter);

    await expect(runtime.preview(selection())).rejects.toMatchObject({
      code: "scope-unavailable",
    });
    expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.readBinary).not.toHaveBeenCalled();
  });

  it("rejects changed identity or folder scope before reading the active note or creating storage", async () => {
    mkdirSync(join(fixture.vaultRoot, "Other"));
    const cases: Array<{
      name: string;
      change: () => void;
      code: "identity-mismatch" | "stale-preview";
    }> = [
      {
        name: "identity",
        change: () => {
          fixture.live.vaultId = "other-vault-id";
        },
        code: "identity-mismatch",
      },
      {
        name: "scope",
        change: () => {
          fixture.live.scopePath = "Other";
        },
        code: "stale-preview",
      },
    ];

    for (const testCase of cases) {
      const runtime = runtimeFor(fixture);
      const preview = await runtime.preview(selection());
      const confirmation = runtime.issueConfirmation(preview.previewId);
      testCase.change();

      await expect(runtime.execute({ confirmation })).rejects.toMatchObject({
        code: testCase.code,
      });
      expect(fixture.read).not.toHaveBeenCalled();
      expect(fixture.readBinary).not.toHaveBeenCalled();
      expect(existsSync(preview.storageRoot)).toBe(false);
      runtime.dispose();
      fixture.live.vaultId = "stable-vault-id";
      fixture.live.scopePath = "Notes";
    }
  });

  it("rereads and digest-binds the actual note before any image read", async () => {
    const runtime = runtimeFor(fixture);
    const preview = await runtime.preview(selection());
    const confirmation = runtime.issueConfirmation(preview.previewId);
    fixture.setNoteText(`${NOTE_TEXT}\nChanged after preview`);

    await expect(runtime.execute({ confirmation })).rejects.toMatchObject({
      code: "stale-preview",
    });
    expect(fixture.read).toHaveBeenCalledTimes(1);
    expect(fixture.readBinary).not.toHaveBeenCalled();
    expect(existsSync(preview.storageRoot)).toBe(false);
  });

  it("rechecks live scope after the asynchronous note read and before the first image read", async () => {
    mkdirSync(join(fixture.vaultRoot, "Other"));
    const runtime = runtimeFor(fixture);
    const preview = await runtime.preview(selection());
    const confirmation = runtime.issueConfirmation(preview.previewId);
    fixture.read.mockImplementation(async () => {
      fixture.live.scopePath = "Other";
      return NOTE_TEXT;
    });

    await expect(runtime.execute({ confirmation })).rejects.toMatchObject({
      code: "stale-preview",
    });
    expect(fixture.read).toHaveBeenCalledTimes(1);
    expect(fixture.readBinary).not.toHaveBeenCalled();
    expect(existsSync(preview.storageRoot)).toBe(false);
  });

  it("guards each image authorization when live scope changes after the final preflight", async () => {
    mkdirSync(join(fixture.vaultRoot, "Other"));
    let calls = 0;
    const getter = jest.fn(async () => {
      calls += 1;
      const snapshot = { ...fixture.live };
      if (calls === 5) fixture.live.scopePath = "Other";
      return snapshot;
    });
    const runtime = runtimeFor(fixture, getter);
    const preview = await runtime.preview(selection());
    const confirmation = runtime.issueConfirmation(preview.previewId);

    const result = await runtime.execute({ confirmation });

    expect(result.persistedCount).toBe(0);
    expect(result.items[0]).toMatchObject({ status: "rejected", reason: "out-of-scope" });
    expect(fixture.readBinary).not.toHaveBeenCalled();
    expect(existsSync(preview.storageRoot)).toBe(true);
  });

  it("surfaces the explicit input bound instead of claiming all note embeds were processed", async () => {
    const noteText = Array.from(
      { length: LOCAL_IMAGE_RUNTIME_MAX_INPUTS + 6 },
      (_, index) => `![[asset-${index}.png]]`
    ).join("\n");
    const runtime = runtimeFor(fixture);

    const preview = await runtime.preview({
      notePath: NOTE_PATH,
      scopePath: "Notes",
      noteText,
    });

    expect(preview.candidateCount).toBe(LOCAL_IMAGE_RUNTIME_MAX_INPUTS);
    expect(preview.truncated).toBe(true);
    expect(preview.omittedCount).toBe(6);
    expect(fixture.readBinary).not.toHaveBeenCalled();
  });

  it("invalidates confirmation on dispose and does not create storage", async () => {
    const runtime = runtimeFor(fixture);
    const preview = await runtime.preview(selection());
    const confirmation = runtime.issueConfirmation(preview.previewId);
    runtime.dispose();

    await expect(runtime.execute({ confirmation })).rejects.toMatchObject({ code: "disposed" });
    await expect(runtime.preview(selection())).rejects.toMatchObject({ code: "disposed" });
    expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.readBinary).not.toHaveBeenCalled();
    expect(existsSync(preview.storageRoot)).toBe(false);
  });

  it("stops a started operation after dispose before the deferred note read completes", async () => {
    const runtime = runtimeFor(fixture);
    const preview = await runtime.preview(selection());
    const confirmation = runtime.issueConfirmation(preview.previewId);
    let releaseNote: (text: string) => void = () => undefined;
    const pendingNote = new Promise<string>((resolve) => {
      releaseNote = resolve;
    });
    fixture.read.mockReturnValue(pendingNote);
    const execution = runtime.execute({ confirmation });
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    expect(fixture.read).toHaveBeenCalledTimes(1);

    runtime.dispose();
    releaseNote(NOTE_TEXT);
    await expect(execution).rejects.toMatchObject({ code: "disposed" });
    expect(fixture.readBinary).not.toHaveBeenCalled();
    expect(existsSync(preview.storageRoot)).toBe(false);
  });

  it("rejects a symlinked storage bucket after confirmation without reading an image", async () => {
    const runtime = runtimeFor(fixture);
    const preview = await runtime.preview(selection());
    const outside = join(fixture.parent, "outside-storage");
    mkdirSync(outside);
    mkdirSync(dirname(preview.storageRoot), { recursive: true });
    symlinkSync(outside, preview.storageRoot);
    const confirmation = runtime.issueConfirmation(preview.previewId);

    await expect(runtime.execute({ confirmation })).rejects.toMatchObject({
      code: "storage-unavailable",
    });
    expect(fixture.readBinary).not.toHaveBeenCalled();
    expect(existsSync(join(outside, "attachments-v1"))).toBe(false);
  });

  it("fails closed on mobile before loading any Node capability", () => {
    const mockedRequireNodeModule = jest.mocked(requireNodeModule);
    mockedRequireNodeModule.mockClear();

    expect(() =>
      createLocalImageRuntime({
        app: fixture.app,
        vault: fixture.vault,
        vaultId: "stable-vault-id",
        homeDir: fixture.homeDir,
        getLiveScope: () => fixture.live,
        isDesktopRuntime: () => false,
      })
    ).toThrow("requires the desktop runtime");
    expect(mockedRequireNodeModule).not.toHaveBeenCalled();
  });

  it("accepts a persisted eight-hex host identity when the live identity agrees", async () => {
    const persistedVaultId = "0123abcd";
    const runtime = createLocalImageRuntime({
      app: fixture.app,
      vault: fixture.vault,
      vaultId: persistedVaultId,
      homeDir: fixture.homeDir,
      getLiveScope: () => ({ ...fixture.live, vaultId: persistedVaultId }),
      isDesktopRuntime: () => true,
    });

    const preview = await runtime.preview(selection());

    expect(preview.candidateCount).toBe(1);
    expect(preview.storageRoot).toContain(join(fixture.homeDir, ".obsidian-copilot"));
  });

  it("rejects the default identity fallback and buckets a cloned canonical vault separately", async () => {
    expect(() =>
      createLocalImageRuntime({
        app: fixture.app,
        vault: fixture.vault,
        vaultId: "default",
        homeDir: fixture.homeDir,
        getLiveScope: () => fixture.live,
        isDesktopRuntime: () => true,
      })
    ).toThrow("stable host vault identity");
    const clonedRoot = join(fixture.parent, "cloned-vault");
    mkdirSync(join(clonedRoot, "Notes", "assets"), { recursive: true });
    writeFileSync(join(clonedRoot, NOTE_PATH), NOTE_TEXT);
    writeFileSync(join(clonedRoot, IMAGE_PATH), PNG_BYTES);
    const clonedNoteFile = mockTFile({
      path: NOTE_PATH,
      extension: "md",
      stat: { size: Buffer.byteLength(NOTE_TEXT), mtime: 1, ctime: 1 },
    });
    const clonedImageFile = mockTFile({
      path: IMAGE_PATH,
      extension: "png",
      stat: { size: PNG_BYTES.byteLength, mtime: 1, ctime: 1 },
    });
    const clonedAdapter = new FileSystemAdapterMock(clonedRoot);
    const clonedVault = {
      adapter: clonedAdapter,
      getAbstractFileByPath: jest.fn((path: string) =>
        path === NOTE_PATH ? clonedNoteFile : null
      ),
      read: jest.fn(async () => NOTE_TEXT),
      readBinary: jest.fn(async (file: TFile) => {
        const bytes = Uint8Array.from(readFileSync(join(clonedRoot, file.path)));
        const result = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(result).set(bytes);
        return result;
      }),
    } as unknown as Vault;
    const clonedApp = {
      vault: clonedVault,
      metadataCache: {
        getFirstLinkpathDest: jest.fn((reference: string) =>
          reference === "assets/diagram.png" || reference === IMAGE_PATH ? clonedImageFile : null
        ),
      },
    } as unknown as App;
    const first = runtimeFor(fixture);
    const second = createLocalImageRuntime({
      app: clonedApp,
      vault: clonedVault,
      vaultId: "stable-vault-id",
      homeDir: fixture.homeDir,
      getLiveScope: () => ({
        vaultId: "stable-vault-id",
        notePath: NOTE_PATH,
        scopePath: "Notes",
      }),
      isDesktopRuntime: () => true,
    });
    const firstPreview = await first.preview(selection());
    const secondPreview = await second.preview(selection());
    expect(firstPreview.storageRoot).not.toBe(secondPreview.storageRoot);
  });
});

function selection(): { notePath: string; scopePath: string; noteText: string } {
  return { notePath: NOTE_PATH, scopePath: "Notes", noteText: NOTE_TEXT };
}

function runtimeFor(
  currentFixture: Fixture,
  getLiveScope:
    | jest.Mock
    | (() => LocalImageRuntimeLiveScope | Promise<LocalImageRuntimeLiveScope>) = jest.fn(
    async () => ({ ...currentFixture.live })
  )
): LocalImageRuntime {
  return createLocalImageRuntime({
    app: currentFixture.app,
    vault: currentFixture.vault,
    vaultId: "stable-vault-id",
    homeDir: currentFixture.homeDir,
    getLiveScope,
    isDesktopRuntime: () => true,
  });
}

function createFixture(): Fixture {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "copilot-local-image-runtime-")));
  const homeDir = join(parent, "home");
  const vaultRoot = join(parent, "vault");
  mkdirSync(homeDir);
  mkdirSync(join(vaultRoot, "Notes", "assets"), { recursive: true });
  writeFileSync(join(vaultRoot, NOTE_PATH), NOTE_TEXT);
  writeFileSync(join(vaultRoot, IMAGE_PATH), PNG_BYTES);

  const noteFile = mockTFile({
    path: NOTE_PATH,
    extension: "md",
    stat: { size: Buffer.byteLength(NOTE_TEXT), mtime: 1, ctime: 1 },
  });
  const imageFile = mockTFile({
    path: IMAGE_PATH,
    extension: "png",
    stat: { size: PNG_BYTES.byteLength, mtime: 1, ctime: 1 },
  });
  let noteText = NOTE_TEXT;
  const live: MutableLiveScope = {
    vaultId: "stable-vault-id",
    notePath: NOTE_PATH,
    scopePath: "Notes",
  };
  const adapter = new FileSystemAdapterMock(vaultRoot);
  const resolveLink = jest.fn((reference: string, _sourceNotePath: string) => {
    return reference === "assets/diagram.png" || reference === IMAGE_PATH ? imageFile : null;
  });
  const read = jest.fn(async (_file: TFile) => noteText);
  const readBinary = jest.fn(async (file: TFile) => {
    expect(file.path).toBe(IMAGE_PATH);
    return PNG_BYTES.slice().buffer;
  });
  const getAbstractFileByPath = jest.fn((path: string) =>
    path === NOTE_PATH ? noteFile : path === IMAGE_PATH ? imageFile : null
  );
  const vault = {
    adapter,
    getAbstractFileByPath,
    read,
    readBinary,
  } as unknown as Vault;
  const app = {
    vault,
    metadataCache: { getFirstLinkpathDest: resolveLink },
  } as unknown as App;

  return {
    parent,
    homeDir,
    vaultRoot,
    app,
    vault,
    live,
    noteFile,
    imageFile,
    read,
    readBinary,
    resolveLink,
    setNoteText(text: string) {
      noteText = text;
      noteFile.stat = { ...noteFile.stat, size: Buffer.byteLength(text) };
    },
  };
}
