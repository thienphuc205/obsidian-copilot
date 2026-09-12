import type { App } from "obsidian";

const mockGetSettings = jest.fn<Record<string, unknown>, []>();
const mockIsMiyoActive = jest.fn<boolean, []>();
const mockHasSelfHostSearchKey = jest.fn<boolean, []>();
const mockSelfHostWebSearch = jest.fn<
  Promise<{ content: string; citations: string[] }>,
  [string]
>();
const mockGetStandaloneQuestion = jest.fn<Promise<string>, [string]>();

jest.mock("@/settings/model", () => ({
  getSettings: () => mockGetSettings(),
}));
jest.mock("@/search/RetrieverFactory", () => ({
  RetrieverFactory: {
    isMiyoActive: () => mockIsMiyoActive(),
  },
}));
// The retriever/tool-execution modules pull "@/utils" in transitively; the real
// module is out of this suite's scope, so stub the two functions the reachable
// paths need.
jest.mock("@/utils", () => ({
  err2String: (error: unknown) => String(error),
  extractNoteFiles: () => [],
}));
// QueryExpander (transitive via the retrievers) resolves its timeout through
// "@/modelManagement"; stub the one function the reachable paths need.
jest.mock("@/modelManagement", () => ({
  resolveLocalAwareTimeout: () => 30_000,
}));
jest.mock("@/LLMProviders/selfHostServices", () => ({
  hasSelfHostSearchKey: () => mockHasSelfHostSearchKey(),
  selfHostWebSearch: (query: string) => mockSelfHostWebSearch(query),
}));
// getStandaloneQuestion streams through the configured chat model; the web-search
// tests stub it so the tool's own contract is what's under test.
jest.mock("@/chainUtils", () => ({
  getStandaloneQuestion: (question: string) => mockGetStandaloneQuestion(question),
}));

import { createLocalSearchTool, webSearchTool } from "@/tools/SearchTools";

describe("SearchTools", () => {
  describe("createLocalSearchTool()", () => {
    const schema = createLocalSearchTool({} as App).schema;

    it("reports unavailable instead of using keyword search when enabled Miyo cannot run on mobile (https://github.com/Brevilabs/obsidian-copilot-private/issues/356)", async () => {
      mockGetSettings.mockReturnValue({ enableMiyo: true });
      mockIsMiyoActive.mockReturnValue(false);
      const tool = createLocalSearchTool({} as App);
      const invoke = tool.invoke.bind(tool) as (input: {
        query: string;
        salientTerms: string[];
      }) => Promise<string>;

      await expect(invoke({ query: "vault notes", salientTerms: [] })).rejects.toThrow(
        "Miyo is unavailable. Configure a remote Miyo connection, then retry vault search."
      );
    });

    it("accepts epoch time ranges", () => {
      const result = schema.safeParse({
        query: "meetings last week",
        salientTerms: ["meetings"],
        timeRange: {
          startTime: 1234567890000,
          endTime: 1234567900000,
        },
      });

      expect(result.success).toBe(true);
    });

    it("accepts an empty salient-terms list and omitted optional search metadata", () => {
      expect(schema.safeParse({ query: "what did I do last week", salientTerms: [] }).success).toBe(
        true
      );
    });

    it("accepts partial numeric time ranges for the tool handler to sanitize", () => {
      expect(
        schema.safeParse({
          query: "notes since yesterday",
          salientTerms: ["notes"],
          timeRange: { startTime: 1234567890000 },
        }).success
      ).toBe(true);
    });

    it("rejects empty queries and missing salient terms", () => {
      expect(schema.safeParse({ query: "", salientTerms: ["test"] }).success).toBe(false);
      expect(schema.safeParse({ query: "test query" }).success).toBe(false);
    });

    it("rejects legacy TimeInfo objects", () => {
      expect(
        schema.safeParse({
          query: "meetings last week",
          salientTerms: ["meetings"],
          timeRange: {
            startTime: { epoch: 1234567890000 },
            endTime: { epoch: 1234567900000 },
          },
        }).success
      ).toBe(false);
    });
  });

  describe("webSearchTool schema", () => {
    const schema = webSearchTool.schema;

    it("accepts user and assistant chat history entries", () => {
      expect(
        schema.safeParse({
          query: "TypeScript tutorials",
          chatHistory: [
            { role: "user", content: "I want to learn TypeScript" },
            { role: "assistant", content: "I can help with that." },
          ],
        }).success
      ).toBe(true);
      expect(schema.safeParse({ query: "TypeScript tutorials", chatHistory: [] }).success).toBe(
        true
      );
    });

    it("rejects empty queries and malformed chat history entries", () => {
      expect(schema.safeParse({ query: "", chatHistory: [] }).success).toBe(false);
      expect(
        schema.safeParse({
          query: "search query",
          chatHistory: [{ role: "system", content: "System message" }],
        }).success
      ).toBe(false);
      expect(
        schema.safeParse({
          query: "search query",
          chatHistory: [{ role: "user" }],
        }).success
      ).toBe(false);
    });
  });

  describe("webSearchTool()", () => {
    const invokeWebSearch = async (input: { query: string; chatHistory: unknown[] }) => {
      const tool = webSearchTool;
      const invoke = tool.invoke.bind(tool) as (input: unknown) => Promise<string>;
      return JSON.parse(await invoke(input)) as unknown;
    };

    it("returns an error document when self-host mode is off (no relay fallback)", async () => {
      mockGetSettings.mockReturnValue({ enableSelfHostMode: false });

      const result = await invokeWebSearch({ query: "rust vs go", chatHistory: [] });

      expect(result).toEqual({
        error: "Web search requires a self-host web search provider key in settings",
      });
      expect(mockSelfHostWebSearch).not.toHaveBeenCalled();
      expect(mockGetStandaloneQuestion).not.toHaveBeenCalled();
    });

    it("returns an error document when no self-host search key is configured", async () => {
      mockGetSettings.mockReturnValue({ enableSelfHostMode: true });
      mockHasSelfHostSearchKey.mockReturnValue(false);

      const result = await invokeWebSearch({ query: "rust vs go", chatHistory: [] });

      expect(result).toEqual({
        error: "Web search requires a self-host web search provider key in settings",
      });
      expect(mockSelfHostWebSearch).not.toHaveBeenCalled();
    });

    it("runs the self-host search and returns a web_search document when configured", async () => {
      mockGetSettings.mockReturnValue({ enableSelfHostMode: true });
      mockHasSelfHostSearchKey.mockReturnValue(true);
      mockGetStandaloneQuestion.mockResolvedValue("standalone query");
      mockSelfHostWebSearch.mockResolvedValue({
        content: "Rust and Go compared",
        citations: ["https://example.com/a"],
      });

      const result = await invokeWebSearch({ query: "rust vs go", chatHistory: [] });

      expect(mockSelfHostWebSearch).toHaveBeenCalledWith("standalone query");
      expect(Array.isArray(result)).toBe(true);
      const [entry] = result as { type: string; content: string; citations: string[] }[];
      expect(entry.type).toBe("web_search");
      expect(entry.content).toBe("Rust and Go compared");
      expect(entry.citations).toEqual(["https://example.com/a"]);
    });
  });
});
