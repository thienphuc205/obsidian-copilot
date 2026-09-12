import {
  deriveResearchProgress,
  isResearchRun,
  toResearchToolEvent,
} from "@/agentMode/ui/researchProgress";

describe("researchProgress", () => {
  describe("isResearchRun()", () => {
    it("detects the seeded quick-action prompt prefix", () => {
      expect(
        isResearchRun(
          "Use the research skill for: Deep sea vents. Show the plan first, search the vault " +
            "before the web, and write the result into the research note you create."
        )
      ).toBe(true);
    });

    it("matches the prefix case-insensitively and mid-message", () => {
      expect(
        isResearchRun("also:\n\nUSE THE RESEARCH SKILL FOR: Tides. Show the plan first.")
      ).toBe(true);
    });

    it("detects an explicit research-skill mention without the seeded prefix", () => {
      expect(isResearchRun("please use the research skill on quantum tunneling")).toBe(true);
    });

    it("rejects undefined, empty, and unrelated messages", () => {
      expect(isResearchRun(undefined)).toBe(false);
      expect(isResearchRun("")).toBe(false);
      expect(isResearchRun("summarize my research notes about tides")).toBe(false);
      expect(isResearchRun("what is the tallest mountain?")).toBe(false);
    });
  });

  describe("deriveResearchProgress()", () => {
    it("returns null for an event-less run so the caller keeps the plain trail", () => {
      expect(deriveResearchProgress([])).toBeNull();
    });

    it("starts the run with plan active, gathers active, and write pending", () => {
      const progress = deriveResearchProgress([{ toolName: "TodoWrite", input: "{}" }]);
      expect(progress?.steps.map((s) => [s.id, s.status, s.count])).toEqual([
        ["plan", "active", undefined],
        ["vault", "active", 0],
        ["web", "active", 0],
        ["write", "pending", undefined],
      ]);
      expect(progress?.targetNotePath).toBeUndefined();
    });

    it("marks plan done and counts vault searches across tool families", () => {
      const progress = deriveResearchProgress([
        { toolName: "Bash", input: { command: 'sh "/skills/miyo-search/miyo-search.sh" "tides"' } },
        { toolName: "Grep", input: { pattern: "vents" } },
        { toolName: "localSearch", input: { query: "vents" } },
        { toolName: "lexicalSearch", input: { query: "vents" } },
      ]);
      expect(progress?.steps.find((s) => s.id === "plan")?.status).toBe("done");
      expect(progress?.steps.find((s) => s.id === "vault")).toMatchObject({
        status: "done",
        count: 4,
      });
      expect(progress?.steps.find((s) => s.id === "web")?.status).toBe("active");
    });

    it("counts grep-ish shell commands as vault searches", () => {
      const progress = deriveResearchProgress([
        { toolName: "Bash", input: { command: "grep -rn 'vents' Research/" } },
        { toolName: "Bash", input: { command: "rg 'vents' notes/" } },
      ]);
      expect(progress?.steps.find((s) => s.id === "vault")).toMatchObject({
        status: "done",
        count: 2,
      });
    });

    it("counts web events from both the bridge scripts and native tools", () => {
      const progress = deriveResearchProgress([
        { toolName: "Bash", input: { command: "copilot-web-search 'deep sea vents'" } },
        { toolName: "Bash", input: { command: "copilot-web-fetch https://example.com" } },
        { toolName: "webSearch", input: { query: "vents" } },
        { toolName: "webFetch", input: { url: "https://example.com" } },
      ]);
      expect(progress?.steps.find((s) => s.id === "web")).toMatchObject({
        status: "done",
        count: 4,
      });
      expect(progress?.steps.find((s) => s.id === "plan")?.status).toBe("done");
    });

    it("activates write once both gather steps are done, before any note path appears", () => {
      const progress = deriveResearchProgress([
        { toolName: "Grep", input: { pattern: "vents" } },
        { toolName: "webSearch", input: { query: "vents" } },
      ]);
      expect(progress?.steps.find((s) => s.id === "write")?.status).toBe("active");
    });

    it("keeps write pending while only one gather step is done", () => {
      const progress = deriveResearchProgress([{ toolName: "Grep", input: { pattern: "v" } }]);
      expect(progress?.steps.find((s) => s.id === "write")?.status).toBe("pending");
    });

    it("completes write with the note path mentioned in an event input", () => {
      const progress = deriveResearchProgress([
        { toolName: "Grep", input: { pattern: "vents" } },
        { toolName: "webSearch", input: { query: "vents" } },
        { toolName: "Write", input: { file_path: "Research/Deep sea vents.md" } },
      ]);
      expect(progress?.steps.find((s) => s.id === "write")?.status).toBe("done");
      expect(progress?.targetNotePath).toBe("Research/Deep sea vents.md");
    });

    it("completes write from a path mentioned in event output", () => {
      const progress = deriveResearchProgress([
        { toolName: "Bash", output: "created Research/Tides.md" },
      ]);
      expect(progress?.steps.find((s) => s.id === "write")?.status).toBe("done");
      expect(progress?.targetNotePath).toBe("Research/Tides.md");
    });

    it("collapses repeated writes by letting the last Research/ path win", () => {
      const progress = deriveResearchProgress([
        { toolName: "Write", input: { file_path: "Research/First draft.md" } },
        { toolName: "Edit", input: { file_path: "Research/Deep sea vents.md" } },
      ]);
      expect(progress?.targetNotePath).toBe("Research/Deep sea vents.md");
    });

    it("ignores non-research note paths", () => {
      const progress = deriveResearchProgress([
        { toolName: "Write", input: { file_path: "Notes/Research team.md" } },
      ]);
      expect(progress?.targetNotePath).toBeUndefined();
      expect(progress?.steps.find((s) => s.id === "write")?.status).toBe("pending");
    });
  });

  describe("toResearchToolEvent()", () => {
    it("normalizes a tool_call part: vendor name wins, input stringifies, text outputs join", () => {
      const event = toResearchToolEvent({
        vendorToolName: "Bash",
        title: "Bash",
        input: { command: "sh miyo-search.sh tides" },
        output: [
          { type: "text", text: "wrote Research/Tides.md" },
          { type: "text", text: "done" },
        ],
      });
      expect(event.toolName).toBe("Bash");
      expect(event.input).toBe('{"command":"sh miyo-search.sh tides"}');
      expect(event.output).toBe("wrote Research/Tides.md\ndone");
    });

    it("falls back through toolName then title for the tool name", () => {
      expect(toResearchToolEvent({ toolName: "localSearch", title: "Local search" }).toolName).toBe(
        "localSearch"
      );
      expect(toResearchToolEvent({ title: "Local search" }).toolName).toBe("Local search");
      expect(toResearchToolEvent({}).toolName).toBeUndefined();
    });

    it("bounds untrusted strings to the documented caps", () => {
      const event = toResearchToolEvent({
        toolName: "x".repeat(100),
        input: "i".repeat(5000),
        output: "o".repeat(3000),
      });
      expect(event.toolName?.length).toBe(64);
      expect((event.input as string).length).toBe(4000);
      expect(event.output?.length).toBe(2000);
    });

    it("returns an empty event for non-object payloads and unserializable input", () => {
      expect(toResearchToolEvent("junk")).toEqual({});
      expect(toResearchToolEvent(null)).toEqual({});
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(toResearchToolEvent({ input: circular }).input).toBeUndefined();
    });

    it("keeps string inputs verbatim (bounded) instead of JSON-quoting them", () => {
      expect(toResearchToolEvent({ input: "grep vents" }).input).toBe("grep vents");
    });
  });
});
