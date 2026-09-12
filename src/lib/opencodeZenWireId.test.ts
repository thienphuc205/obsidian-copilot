import { OPENCODE_ZEN_PROVIDER_ID, isOpencodeZenWireId } from "./opencodeZenWireId";

describe("opencodeZenWireId", () => {
  describe("isOpencodeZenWireId()", () => {
    it("matches the opencode/ prefix only", () => {
      expect(isOpencodeZenWireId("opencode/big-pickle")).toBe(true);
      expect(isOpencodeZenWireId("opencode/deepseek-v4-flash-free")).toBe(true);
      expect(isOpencodeZenWireId("lmstudio/gpt-oss-20b")).toBe(false);
      expect(isOpencodeZenWireId("openrouter/anthropic/claude")).toBe(false);
      expect(isOpencodeZenWireId("opencode-zen/x")).toBe(false); // prefix must be exactly `opencode/`
    });
  });

  describe("OPENCODE_ZEN_PROVIDER_ID", () => {
    it("is the exact wire-id prefix segment the helper matches", () => {
      expect(isOpencodeZenWireId(`${OPENCODE_ZEN_PROVIDER_ID}/m`)).toBe(true);
    });
  });
});
