import { executeSequentialToolCall, type ToolCall } from "./toolExecution";
import { createLangChainTool } from "@/tools/createLangChainTool";
import { ToolRegistry } from "@/tools/ToolRegistry";
import { z } from "zod";

// Mock dependencies
jest.mock("@/logger", () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
}));

jest.mock("@/tools/toolManager", () => ({
  ToolManager: {
    callTool: jest.fn(),
  },
}));

import { ToolManager } from "@/tools/toolManager";

describe("toolExecution", () => {
  const mockCallTool = ToolManager.callTool as jest.MockedFunction<typeof ToolManager.callTool>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Clear the registry before each test
    ToolRegistry.getInstance().clear();
  });

  describe("executeSequentialToolCall", () => {
    it("should execute a tool through the tool manager", async () => {
      const testTool = createLangChainTool({
        name: "testTool",
        description: "Test tool",
        schema: z.object({ input: z.string() }),
        func: async ({ input }) => `Result: ${input}`,
      });

      ToolRegistry.getInstance().register({
        tool: testTool,
        metadata: {
          id: "testTool",
          displayName: "Test Tool",
          description: "Test tool",
          category: "custom",
        },
      });

      mockCallTool.mockResolvedValueOnce("Tool executed successfully");

      const result = await executeSequentialToolCall(
        { name: "testTool", args: { input: "test" } },
        [testTool]
      );

      expect(result).toEqual({
        toolName: "testTool",
        result: "Tool executed successfully",
        success: true,
      });
    });

    it("should handle tool not found", async () => {
      const result = await executeSequentialToolCall({ name: "unknownTool", args: {} }, []);

      expect(result).toEqual({
        toolName: "unknownTool",
        result:
          "Error: Tool 'unknownTool' not found. Available tools: . Make sure you have the tool enabled in the Agent settings.",
        success: false,
      });
    });

    it("should handle invalid tool call", async () => {
      const result = await executeSequentialToolCall(null as unknown as ToolCall, []);

      expect(result).toEqual({
        toolName: "unknown",
        result: "Error: Invalid tool call - missing tool name",
        success: false,
      });
    });

    it("should execute writeFile normally for any file path", async () => {
      const writeFile = createLangChainTool({
        name: "writeFile",
        description: "Write to file",
        schema: z.object({ path: z.string(), content: z.string() }),
        func: async () => "written",
      });
      const obsidianBases = createLangChainTool({
        name: "obsidianBases",
        description: "Bases CLI",
        schema: z.object({ command: z.string() }),
        func: async () => "queried",
      });

      ToolRegistry.getInstance().register({
        tool: writeFile,
        metadata: { id: "writeFile", displayName: "Write", description: "", category: "file" },
      });

      mockCallTool.mockResolvedValueOnce("File written");

      const result = await executeSequentialToolCall(
        { name: "writeFile", args: { path: "Notes/todo.md", content: "# Todo" } },
        [writeFile, obsidianBases]
      );

      expect(result.success).toBe(true);
      expect(mockCallTool).toHaveBeenCalled();
    });
  });
});
