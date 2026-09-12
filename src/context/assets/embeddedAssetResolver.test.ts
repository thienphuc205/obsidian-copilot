import { webcrypto } from "crypto";
import type { TFile } from "obsidian";

import { mockTFile } from "@/__tests__/mockObsidian";

import {
  MAX_LOCAL_IMAGE_BYTES,
  type LocalImageReader,
  type LocalImageResolution,
} from "@/context/assets/assetTypes";
import { resolveEmbeddedLocalImage } from "@/context/assets/embeddedAssetResolver";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BUFFER = PNG_BYTES.buffer;

beforeAll(() => {
  if (!window.crypto?.subtle) {
    Object.defineProperty(window, "crypto", { configurable: true, value: webcrypto });
  }
});

interface ReaderHarness {
  reader: LocalImageReader;
  resolveLink: jest.Mock;
  readBinary: jest.Mock;
  authorizeResolvedFile: jest.Mock;
  getVaultId: jest.Mock;
}

function mockFile(path: string, extension = "png", size = PNG_BYTES.byteLength): TFile {
  return mockTFile({
    path,
    extension,
    stat: { size, mtime: 1, ctime: 1 },
  });
}

function harness(file: TFile | null, bytes: ArrayBuffer = PNG_BUFFER): ReaderHarness {
  const resolveLink = jest.fn().mockReturnValue(file);
  const readBinary = jest.fn().mockResolvedValue(bytes);
  const authorizeResolvedFile = jest.fn().mockResolvedValue(true);
  const getVaultId = jest.fn().mockReturnValue("vault-test");
  return {
    reader: { resolveLink, readBinary, authorizeResolvedFile, getVaultId },
    resolveLink,
    readBinary,
    authorizeResolvedFile,
    getVaultId,
  };
}

describe("embeddedAssetResolver", () => {
  describe("resolveEmbeddedLocalImage()", () => {
    it("resolves a valid parent-relative image after host authorization and preserves source identity", async () => {
      const file = mockFile("assets/diagram image.png");
      const testHarness = harness(file);
      const events: string[] = [];
      testHarness.authorizeResolvedFile.mockImplementation(async () => {
        events.push("authorize");
        return true;
      });
      testHarness.readBinary.mockImplementation(async () => {
        events.push("read");
        return PNG_BUFFER;
      });

      const result = await resolveEmbeddedLocalImage(
        "../assets/diagram%20image.png#preview",
        "Notes/reading.md",
        testHarness.reader
      );

      expect(result).toMatchObject({
        status: "resolved",
        mimeType: "image/png",
        source: {
          vaultId: "vault-test",
          vaultPath: "assets/diagram image.png",
          sourceNotePath: "Notes/reading.md",
          kind: "image",
          mediaType: "image/png",
          byteLength: PNG_BYTES.byteLength,
        },
        bytes: PNG_BUFFER,
      });
      expect(testHarness.resolveLink).toHaveBeenCalledWith(
        "../assets/diagram image.png",
        "Notes/reading.md"
      );
      expect(events).toEqual(["authorize", "read"]);
    });

    it("allows a valid parent traversal that remains inside the vault", async () => {
      const testHarness = harness(mockFile("assets/photo.png"));

      const result = await resolveEmbeddedLocalImage(
        "../../assets/photo.png",
        "Notes/Deep/reading.md",
        testHarness.reader
      );

      expect(result.status).toBe("resolved");
      expect(testHarness.resolveLink).toHaveBeenCalledWith(
        "../../assets/photo.png",
        "Notes/Deep/reading.md"
      );
    });

    it("rejects traversal beyond the vault before asking the host to resolve it", async () => {
      const testHarness = harness(mockFile("outside.png"));

      const result = await resolveEmbeddedLocalImage(
        "../../../outside.png",
        "Notes/Deep/reading.md",
        testHarness.reader
      );

      expect(result).toEqual({
        status: "rejected",
        reason: "out-of-scope",
        reference: "../../../outside.png",
      });
      expect(testHarness.resolveLink).not.toHaveBeenCalled();
      expect(testHarness.readBinary).not.toHaveBeenCalled();
    });

    it.each([
      ["https://example.com/image.png", "external"],
      ["http://example.com/image.png", "external"],
      ["data:image/png;base64,AAAA", "external"],
      ["file:///Users/example/image.png", "external"],
      ["/Users/example/image.png", "out-of-scope"],
      ["C:\\Users\\example\\image.png", "out-of-scope"],
      ["\\\\server\\share\\image.png", "out-of-scope"],
    ])(
      "rejects external or absolute reference %s without host reads",
      async (reference, reason) => {
        const testHarness = harness(mockFile("assets/image.png"));

        const result = await resolveEmbeddedLocalImage(
          reference,
          "Notes/reading.md",
          testHarness.reader
        );

        expect(result).toMatchObject({ status: "rejected", reason, reference });
        expect(testHarness.resolveLink).not.toHaveBeenCalled();
        expect(testHarness.readBinary).not.toHaveBeenCalled();
      }
    );

    it("passes an app URI only to the injected vault resolver and still validates the returned TFile", async () => {
      const testHarness = harness(mockFile("assets/image.png"));

      const result = await resolveEmbeddedLocalImage(
        "app://vault/opaque-image",
        undefined,
        testHarness.reader
      );

      expect(result.status).toBe("resolved");
      expect(testHarness.resolveLink).toHaveBeenCalledWith("app://vault/opaque-image", undefined);
    });

    it("rejects an unknown extension before reading bytes", async () => {
      const testHarness = harness(mockFile("assets/image.svg", "svg"));

      const result = await resolveEmbeddedLocalImage(
        "assets/image.svg",
        undefined,
        testHarness.reader
      );

      expect(result).toEqual({
        status: "rejected",
        reason: "unsupported",
        reference: "assets/image.svg",
      });
      expect(testHarness.readBinary).not.toHaveBeenCalled();
    });

    it("rejects a resolved file whose host authorization fails before reading bytes", async () => {
      const testHarness = harness(mockFile("assets/image.png"));
      testHarness.authorizeResolvedFile.mockResolvedValue(false);

      const result = await resolveEmbeddedLocalImage(
        "assets/image.png",
        undefined,
        testHarness.reader
      );

      expect(result).toEqual({
        status: "rejected",
        reason: "out-of-scope",
        reference: "assets/image.png",
      });
      expect(testHarness.readBinary).not.toHaveBeenCalled();
    });

    it("rejects a malformed reader without an authorization callback before reading bytes", async () => {
      const testHarness = harness(mockFile("assets/image.png"));
      const malformedReader = {
        resolveLink: testHarness.resolveLink,
        readBinary: testHarness.readBinary,
        getVaultId: testHarness.getVaultId,
      } as unknown as LocalImageReader;

      const result = await resolveEmbeddedLocalImage(
        "assets/image.png",
        undefined,
        malformedReader
      );

      expect(result).toEqual({
        status: "rejected",
        reason: "out-of-scope",
        reference: "assets/image.png",
      });
      expect(testHarness.readBinary).not.toHaveBeenCalled();
    });

    it("rejects a throwing authorization callback before reading bytes", async () => {
      const testHarness = harness(mockFile("assets/image.png"));
      testHarness.authorizeResolvedFile.mockRejectedValue(new Error("authorization detail"));

      const result = await resolveEmbeddedLocalImage(
        "assets/image.png",
        undefined,
        testHarness.reader
      );

      expect(result).toEqual({
        status: "rejected",
        reason: "out-of-scope",
        reference: "assets/image.png",
      });
      expect(testHarness.readBinary).not.toHaveBeenCalled();
    });

    it("rejects a statically oversized file without reading its body", async () => {
      const testHarness = harness(mockFile("assets/image.png", "png", MAX_LOCAL_IMAGE_BYTES + 1));

      const result = await resolveEmbeddedLocalImage(
        "assets/image.png",
        undefined,
        testHarness.reader
      );

      expect(result).toEqual({
        status: "rejected",
        reason: "too-large",
        reference: "assets/image.png",
      });
      expect(testHarness.readBinary).not.toHaveBeenCalled();
    });

    it("maps an oversized body to the bounded too-large rejection", async () => {
      const oversized = new Uint8Array(MAX_LOCAL_IMAGE_BYTES + 1);
      oversized.set(PNG_BYTES);
      const testHarness = harness(mockFile("assets/image.png", "png", 0), oversized.buffer);

      const result = await resolveEmbeddedLocalImage(
        "assets/image.png",
        undefined,
        testHarness.reader
      );

      expect(result).toEqual({
        status: "rejected",
        reason: "too-large",
        reference: "assets/image.png",
      });
    });

    it("maps malformed and MIME-mismatched bodies to invalid-bytes without exposing errors", async () => {
      const invalidHarness = harness(
        mockFile("assets/image.png"),
        new Uint8Array([0, 1, 2]).buffer
      );
      const invalid = await resolveEmbeddedLocalImage(
        "assets/image.png",
        undefined,
        invalidHarness.reader
      );
      expect(invalid).toEqual({
        status: "rejected",
        reason: "unsupported",
        reference: "assets/image.png",
      });

      const mismatchHarness = harness(mockFile("assets/image.jpg", "jpg"), PNG_BUFFER);
      const mismatch = await resolveEmbeddedLocalImage(
        "assets/image.jpg",
        undefined,
        mismatchHarness.reader
      );
      expect(mismatch).toEqual({
        status: "rejected",
        reason: "invalid-bytes",
        reference: "assets/image.jpg",
      });
      expect(mismatch).not.toHaveProperty("message");
    });

    it("maps host resolution and binary failures to not-found without leaking error text", async () => {
      const resolveFailure = harness(null);
      resolveFailure.resolveLink.mockImplementation(() => {
        throw new Error("private vault detail");
      });
      const missing = await resolveEmbeddedLocalImage(
        "assets/missing.png",
        undefined,
        resolveFailure.reader
      );
      expect(missing).toEqual({
        status: "rejected",
        reason: "not-found",
        reference: "assets/missing.png",
      });

      const readFailure = harness(mockFile("assets/image.png"));
      readFailure.readBinary.mockRejectedValue(new Error("secret binary detail"));
      const unreadable = await resolveEmbeddedLocalImage(
        "assets/image.png",
        undefined,
        readFailure.reader
      );
      expect(unreadable).toEqual({
        status: "rejected",
        reason: "not-found",
        reference: "assets/image.png",
      });
    });

    it("bounds an invalid reference in the rejection while avoiding any reader call", async () => {
      const testHarness = harness(mockFile("assets/image.png"));
      const reference = `assets/${"é".repeat(5000)}.png`;

      const result = await resolveEmbeddedLocalImage(reference, undefined, testHarness.reader);

      expect(result.status).toBe("rejected");
      expect((result as Extract<LocalImageResolution, { status: "rejected" }>).reason).toBe(
        "out-of-scope"
      );
      expect(
        (result as Extract<LocalImageResolution, { status: "rejected" }>).reference.length
      ).toBe(4096);
      expect(testHarness.resolveLink).not.toHaveBeenCalled();
    });

    it("rejects a non-relative resolved TFile before authorization or reading", async () => {
      const testHarness = harness(mockFile("../../outside.png"));

      const result = await resolveEmbeddedLocalImage(
        "assets/image.png",
        undefined,
        testHarness.reader
      );

      expect(result).toEqual({
        status: "rejected",
        reason: "out-of-scope",
        reference: "assets/image.png",
      });
      expect(testHarness.authorizeResolvedFile).not.toHaveBeenCalled();
      expect(testHarness.readBinary).not.toHaveBeenCalled();
    });

    it("rejects an empty vault identity after validation without returning a source capability", async () => {
      const testHarness = harness(mockFile("assets/image.png"));
      testHarness.getVaultId.mockReturnValue(" ");

      const result = await resolveEmbeddedLocalImage(
        "assets/image.png",
        undefined,
        testHarness.reader
      );

      expect(result).toEqual({
        status: "rejected",
        reason: "out-of-scope",
        reference: "assets/image.png",
      });
      expect(testHarness.authorizeResolvedFile).not.toHaveBeenCalled();
      expect(testHarness.readBinary).not.toHaveBeenCalled();
    });
  });
});
