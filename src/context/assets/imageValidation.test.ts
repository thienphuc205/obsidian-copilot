import { webcrypto } from "crypto";

import {
  LOCAL_IMAGE_MEDIA_TYPES,
  MAX_LOCAL_IMAGE_BYTES,
  type LocalImageMediaType,
} from "@/context/assets/assetTypes";
import { LocalImageValidationError, inspectLocalImage } from "@/context/assets/imageValidation";

const SIGNATURES: ReadonlyArray<readonly [LocalImageMediaType, number[]]> = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["image/jpeg", [0xff, 0xd8, 0xff, 0xd9]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
  ["image/webp", [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]],
  ["image/bmp", [0x42, 0x4d]],
];

beforeAll(() => {
  if (!window.crypto?.subtle) {
    Object.defineProperty(window, "crypto", { configurable: true, value: webcrypto });
  }
});

function arrayBuffer(values: number[]): ArrayBuffer {
  const bytes = new Uint8Array(values);
  return bytes.buffer;
}

describe("imageValidation", () => {
  describe("LocalImageValidationError", () => {
    describe("constructor()", () => {
      it("keeps the typed reason and a bounded message", () => {
        const error = new LocalImageValidationError("invalid-bytes");

        expect(error).toBeInstanceOf(Error);
        expect(error.reason).toBe("invalid-bytes");
        expect(error.message).toBe("Image bytes are invalid");
        expect(error.message).not.toContain("invalid-bytes");
      });
    });
  });

  describe("inspectLocalImage()", () => {
    it.each(SIGNATURES)(
      "recognizes the bounded %s raster header and returns a digest",
      async (mediaType, bytes) => {
        const inspection = await inspectLocalImage(arrayBuffer(bytes), mediaType);

        expect(inspection.mediaType).toBe(mediaType);
        expect(inspection.byteLength).toBe(bytes.length);
        expect(inspection.extension).toMatch(/^(jpg|png|gif|webp|bmp)$/);
        expect(inspection.contentDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(LOCAL_IMAGE_MEDIA_TYPES).toContain(inspection.mediaType);
      }
    );

    it("accepts a case-insensitive MIME declaration with parameters", async () => {
      const inspection = await inspectLocalImage(
        arrayBuffer([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "IMAGE/PNG; charset=binary"
      );

      expect(inspection.mediaType).toBe("image/png");
    });

    it("accepts image/jpg as the canonical JPEG alias", async () => {
      const inspection = await inspectLocalImage(
        arrayBuffer([0xff, 0xd8, 0xff, 0xd9]),
        "image/jpg"
      );

      expect(inspection.mediaType).toBe("image/jpeg");
      expect(inspection.extension).toBe("jpg");
    });

    it("rejects a declaration whose MIME type disagrees with the magic bytes", async () => {
      const promise = inspectLocalImage(
        arrayBuffer([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/jpeg"
      );

      await expect(promise).rejects.toMatchObject({ reason: "mismatched" });
    });

    it("rejects unsupported declarations without exposing the supplied value", async () => {
      const promise = inspectLocalImage(
        arrayBuffer([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        "image/svg+xml"
      );

      await expect(promise).rejects.toMatchObject({ reason: "unsupported" });
      await expect(promise).rejects.not.toThrow("image/svg+xml");
    });

    it("rejects bytes larger than the shared three mebibyte limit before hashing", async () => {
      const bytes = new Uint8Array(MAX_LOCAL_IMAGE_BYTES + 1);
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

      await expect(inspectLocalImage(bytes.buffer, "image/png")).rejects.toMatchObject({
        reason: "too-large",
      });
    });

    it.each([
      ["empty bytes", []],
      ["unknown magic", [0x00, 0x01, 0x02, 0x03]],
    ])("rejects %s as unsupported raster data", async (_label, bytes) => {
      await expect(inspectLocalImage(arrayBuffer(bytes))).rejects.toMatchObject({
        reason: "unsupported",
      });
    });
  });
});
