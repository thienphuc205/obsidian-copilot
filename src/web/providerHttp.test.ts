import { requestUrl } from "obsidian";
import {
  defaultWebTransport,
  ensureSuccessfulResponse,
  requestWebProvider,
  utf8ByteLengthUpTo,
} from "@/web/providerHttp";
jest.mock("obsidian", () => ({ requestUrl: jest.fn() }));

describe("providerHttp", () => {
  describe("requestWebProvider()", () => {
    it("releases a cancelled in-flight caller without retrying or exposing raw errors", async () => {
      const transport = jest.fn(() => new Promise<never>(() => {}));
      const controller = new AbortController();
      const result = requestWebProvider(
        "Tavily",
        transport,
        "test-key",
        "https://api.tavily.com/search",
        { query: "docs" },
        controller.signal
      );
      controller.abort();
      await expect(result).rejects.toMatchObject({
        code: "timeout",
        message: "The Tavily request was cancelled.",
      });
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transport.mock.calls[0]).toBeDefined();
    });
    it("enforces the same deadline for every provider without a retry", async () => {
      jest.useFakeTimers();
      try {
        const transport = jest.fn(() => new Promise<never>(() => {}));
        const result = requestWebProvider(
          "Tavily",
          transport,
          "test-key",
          "https://api.tavily.com/search",
          {}
        );
        const assertion = expect(result).rejects.toMatchObject({ code: "timeout" });
        await jest.advanceTimersByTimeAsync(30000);
        await assertion;
        expect(transport).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
    });
  });
  describe("defaultWebTransport()", () => {
    it("rejects an oversized response before JSON access", async () => {
      const readJson = jest.fn(() => ({}));
      jest.mocked(requestUrl).mockResolvedValue({
        status: 200,
        headers: {},
        text: "",
        arrayBuffer: new ArrayBuffer(512 * 1024 + 1),
        get json() {
          return readJson();
        },
      });
      await expect(
        defaultWebTransport({
          url: "https://api.tavily.com/search",
          method: "POST",
          headers: {},
          contentType: "application/json",
          body: "{}",
          timeoutMs: 30000,
        })
      ).rejects.toThrow();
      expect(readJson).not.toHaveBeenCalled();
    });
  });
  describe("ensureSuccessfulResponse()", () => {
    it.each([
      [402, "quota_exceeded"],
      [408, "timeout"],
      [403, "unauthorized"],
      [400, "bad_request"],
    ])("maps HTTP %p to %p without a response body", (status, code) => {
      try {
        ensureSuccessfulResponse({ status, json: { secret: "do-not-log" } }, "Tavily");
        throw new Error("Expected provider failure");
      } catch (error) {
        expect(error).toMatchObject({ code, status });
        expect(String(error)).not.toContain("do-not-log");
      }
    });
  });
  describe("utf8ByteLengthUpTo()", () => {
    it("counts Unicode bytes and stops at the bound", () => {
      expect(utf8ByteLengthUpTo("a界😀", 100)).toBe(8);
      expect(utf8ByteLengthUpTo("界".repeat(10000), 4)).toBe(6);
    });
  });
});
