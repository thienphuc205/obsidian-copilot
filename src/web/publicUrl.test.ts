import { normalizePublicUrl, validatePublicUrl } from "@/web/publicUrl";
describe("publicUrl", () => {
  describe("normalizePublicUrl()", () => {
    it.each(["https://fc.example.com", "https://fd.example.com", "https://fe80.example.com"])(
      "accepts public DNS names that happen to start like IPv6: %p",
      (url) => {
        expect(normalizePublicUrl(url)).toBe(url + "/");
      }
    );
    it.each([
      "http://[fc00::1]",
      "http://[fe80::1]",
      "http://[::ffff:a00:1]",
      "http://[::ffff:0:1]",
    ])("rejects private IPv6 and abbreviated mapped IPv4: %p", (url) => {
      expect(normalizePublicUrl(url)).toBeUndefined();
    });
  });
  describe("validatePublicUrl()", () => {
    it("rejects unsafe schemes and normalizes public URLs", () => {
      expect(() => validatePublicUrl("file:///vault/private")).toThrow();
      expect(validatePublicUrl("https://example.com")).toBe("https://example.com/");
    });
  });
});
