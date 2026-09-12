import type { App } from "obsidian";

const mockGetSettings = jest.fn<Record<string, unknown>, []>();
const mockIsMiyoActive = jest.fn<boolean, []>();

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

import { createLocalSearchTool } from "@/tools/SearchTools";

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
});
