import { createWebProvider } from "@/web/provider";
describe("provider", () => {
  describe("createWebProvider()", () => {
    it.each([
      ["firecrawl", "https://api.firecrawl.dev", { success: true, data: [] }, undefined],
      ["tavily", "https://api.tavily.com", { results: [] }, undefined],
      ["exa", "https://api.exa.ai", { results: [] }, undefined],
      [
        "custom",
        "https://search.example.com/api/search",
        { kind: "web_search", content: "", sources: [], citations: [] },
        "https://search.example.com/api",
      ],
    ] as const)(
      "routes %s only to its selected API",
      async (provider, expectedEndpoint, json, baseUrl) => {
        const transport = jest.fn().mockResolvedValue({
          status: 200,
          json,
        });
        const client = createWebProvider({
          provider,
          apiKey: "fixture-key",
          transport,
          ...(baseUrl === undefined ? {} : { baseUrl }),
        });
        expect(transport).not.toHaveBeenCalled();
        await client.search("public query");
        expect(transport.mock.calls[0][0].url).toContain(expectedEndpoint);
      }
    );

    it("rejects Custom without an explicit base URL", () => {
      expect(() => createWebProvider({ provider: "custom", apiKey: "fixture-key" })).toThrow(
        "Custom API provider configuration is invalid."
      );
    });
    it("rejects an unsupported provider without fallback", () => {
      expect(() =>
        createWebProvider({ provider: "unsupported" as never, apiKey: "fixture-key" })
      ).toThrow("Web provider is not supported.");
    });
  });
});
