type DesktopRuntimeModule = typeof import("@/utils/desktopRuntime");

jest.mock("@/utils/desktopRuntime", () => {
  const actual = jest.requireActual<DesktopRuntimeModule>("@/utils/desktopRuntime");
  return { ...actual, isDesktopRuntime: jest.fn(() => true) };
});

import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { FileSystemAdapter, type App, type TFile, type Vault } from "obsidian";

import { mockTFile } from "@/__tests__/mockObsidian";
import type { LocalImageReader } from "@/context/assets/assetTypes";
import { createObsidianLocalImageReader } from "@/context/assets/obsidianLocalImageReader";
import { isDesktopRuntime } from "@/utils/desktopRuntime";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FileSystemAdapterMock = FileSystemAdapter as unknown as new (
  basePath: string
) => FileSystemAdapter;
const mockIsDesktopRuntime = jest.mocked(isDesktopRuntime);

interface Fixture {
  root: string;
  outside: string;
  app: App;
  vault: Vault;
  resolveLink: jest.Mock;
  readBinary: jest.Mock;
}

let fixture: Fixture;

function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "copilot-image-vault-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "copilot-image-outside-")));
  const adapter = new FileSystemAdapterMock(root);
  const resolveLink = jest.fn();
  const readBinary = jest.fn(async (file: TFile) => {
    const bytes = Uint8Array.from(readFileSync(join(root, file.path)));
    return bytes.buffer;
  });
  const vault = { adapter, readBinary } as unknown as Vault;
  const app = {
    vault,
    metadataCache: { getFirstLinkpathDest: resolveLink },
  } as unknown as App;
  return { root, outside, app, vault, resolveLink, readBinary };
}

function writeFixtureImage(relativePath: string, root = fixture.root): TFile {
  const absolutePath = join(root, relativePath);
  mkdirSync(join(absolutePath, ".."), { recursive: true });
  writeFileSync(absolutePath, PNG_BYTES);
  return mockTFile({
    path: relativePath,
    extension: "png",
    stat: { size: PNG_BYTES.byteLength, mtime: 1, ctime: 1 },
  });
}

function reader(options: Partial<{ vaultId: string; scopePath: string }> = {}): LocalImageReader {
  return createObsidianLocalImageReader({
    app: fixture.app,
    vault: fixture.vault,
    vaultId: options.vaultId ?? "vault-test",
    ...(options.scopePath === undefined ? {} : { scopePath: options.scopePath }),
  });
}

describe("obsidianLocalImageReader", () => {
  beforeEach(() => {
    fixture = createFixture();
    mockIsDesktopRuntime.mockReturnValue(true);
  });

  afterEach(() => {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(fixture.outside, { recursive: true, force: true });
  });

  describe("createObsidianLocalImageReader()", () => {
    it("resolves a normal parent-relative link through the explicit app/vault and reads it after canonical authorization", async () => {
      const file = writeFixtureImage("assets/diagram image.png");
      fixture.resolveLink.mockReturnValue(file);
      const localReader = reader({ scopePath: "assets" });

      expect(localReader.getVaultId()).toBe("vault-test");
      expect(localReader.resolveLink("../assets/diagram%20image.png", "Notes/reading.md")).toBe(
        file
      );
      expect(fixture.resolveLink).toHaveBeenCalledWith(
        "../assets/diagram image.png",
        "Notes/reading.md"
      );
      expect(localReader.authorizeResolvedFile(file)).toBe(true);
      await expect(localReader.readBinary(file)).resolves.toEqual(PNG_BYTES.buffer);
      expect(fixture.readBinary).toHaveBeenCalledTimes(1);
    });

    it("rejects remote and absolute references before consulting metadata", () => {
      const localReader = reader();

      expect(
        localReader.resolveLink("https://example.com/image.png", "Notes/reading.md")
      ).toBeNull();
      expect(localReader.resolveLink("/Users/example/image.png", "Notes/reading.md")).toBeNull();
      expect(localReader.resolveLink("data:image/png;base64,AAAA", "Notes/reading.md")).toBeNull();
      expect(fixture.resolveLink).not.toHaveBeenCalled();
    });

    it("denies a resolved target outside the selected scope before the vault read", async () => {
      const file = writeFixtureImage("other/image.png");
      fixture.resolveLink.mockReturnValue(file);
      const localReader = reader({ scopePath: "assets" });

      expect(localReader.authorizeResolvedFile(file)).toBe(false);
      await expect(localReader.readBinary(file)).rejects.toThrow("Local image read denied");
      expect(fixture.readBinary).not.toHaveBeenCalled();
    });

    it("denies a symlink target that escapes the canonical vault root before the vault read", async () => {
      const outsideImage = writeFixtureImage("secret.png", fixture.outside);
      const escapePath = join(fixture.root, "assets", "escape.png");
      mkdirSync(join(fixture.root, "assets"), { recursive: true });
      symlinkSync(join(fixture.outside, outsideImage.path), escapePath);
      const file = mockTFile({
        path: "assets/escape.png",
        extension: "png",
        stat: { size: PNG_BYTES.byteLength, mtime: 1, ctime: 1 },
      });
      fixture.resolveLink.mockReturnValue(file);
      const localReader = reader({ scopePath: "assets" });

      expect(localReader.authorizeResolvedFile(file)).toBe(false);
      await expect(localReader.readBinary(file)).rejects.toThrow("Local image read denied");
      expect(fixture.readBinary).not.toHaveBeenCalled();
    });

    it("denies a canonical target whose relative path is exactly the vault parent", () => {
      const parentEscapePath = join(fixture.root, "assets", "parent.png");
      mkdirSync(join(fixture.root, "assets"), { recursive: true });
      symlinkSync(dirname(fixture.root), parentEscapePath);
      const file = mockTFile({
        path: "assets/parent.png",
        extension: "png",
        stat: { size: PNG_BYTES.byteLength, mtime: 1, ctime: 1 },
      });
      const localReader = reader();

      expect(localReader.authorizeResolvedFile(file)).toBe(false);
    });

    it("revalidates canonical containment immediately before reading after a target is replaced", async () => {
      const file = writeFixtureImage("assets/replaced.png");
      fixture.resolveLink.mockReturnValue(file);
      const localReader = reader({ scopePath: "assets" });

      expect(localReader.authorizeResolvedFile(file)).toBe(true);
      unlinkSync(join(fixture.root, file.path));
      const outsideImage = writeFixtureImage("replacement.png", fixture.outside);
      symlinkSync(join(fixture.outside, outsideImage.path), join(fixture.root, file.path));

      await expect(localReader.readBinary(file)).rejects.toThrow("Local image read denied");
      expect(fixture.readBinary).not.toHaveBeenCalled();
    });

    it("fails closed on mobile before loading the desktop realpath capability", () => {
      const file = writeFixtureImage("assets/mobile.png");
      fixture.resolveLink.mockReturnValue(file);
      const localReader = reader({ scopePath: "assets" });
      mockIsDesktopRuntime.mockReturnValue(false);

      expect(isDesktopRuntime()).toBe(false);
      expect(localReader.authorizeResolvedFile(file)).toBe(false);
      expect(fixture.readBinary).not.toHaveBeenCalled();
    });

    it("fails closed when the vault adapter is not a desktop FileSystemAdapter", () => {
      const file = writeFixtureImage("assets/non-desktop.png");
      fixture.resolveLink.mockReturnValue(file);
      fixture.vault.adapter = {} as Vault["adapter"];
      const localReader = reader({ scopePath: "assets" });

      expect(localReader.authorizeResolvedFile(file)).toBe(false);
    });

    it("fails closed when the explicit app and vault do not match", () => {
      const file = writeFixtureImage("assets/mismatched.png");
      fixture.resolveLink.mockReturnValue(file);
      const otherVault = { adapter: fixture.vault.adapter } as unknown as Vault;
      const localReader = createObsidianLocalImageReader({
        app: fixture.app,
        vault: otherVault,
        vaultId: "vault-test",
        scopePath: "assets",
      });

      expect(localReader.resolveLink("assets/mismatched.png")).toBeNull();
      expect(localReader.authorizeResolvedFile(file)).toBe(false);
      expect(fixture.readBinary).not.toHaveBeenCalled();
    });

    it("fails closed for an invalid vault identity before the vault read", async () => {
      const file = writeFixtureImage("assets/invalid-id.png");
      fixture.resolveLink.mockReturnValue(file);
      const localReader = reader({ vaultId: " " });

      expect(localReader.authorizeResolvedFile(file)).toBe(false);
      await expect(localReader.readBinary(file)).rejects.toThrow("Local image read denied");
      expect(fixture.readBinary).not.toHaveBeenCalled();
    });

    it("sanitizes a vault read failure without returning the host error", async () => {
      const file = writeFixtureImage("assets/failing.png");
      fixture.resolveLink.mockReturnValue(file);
      fixture.readBinary.mockRejectedValue(new Error("/private/user/vault secret"));
      const localReader = reader({ scopePath: "assets" });

      await expect(localReader.readBinary(file)).rejects.toThrow("Local image read failed");
      await expect(localReader.readBinary(file)).rejects.not.toThrow("/private/user/vault secret");
    });
  });
});
