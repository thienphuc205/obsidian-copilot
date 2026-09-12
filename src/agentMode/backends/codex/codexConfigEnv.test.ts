import {
  codexScopeInstructionLine,
  mergeCodexConfigEnv,
} from "@/agentMode/backends/codex/codexConfigEnv";

describe("codexConfigEnv", () => {
  describe("mergeCodexConfigEnv()", () => {
    it("https://github.com/Brevilabs/obsidian-copilot-private/issues/322 applies the product context defaults without inherited values", () => {
      expect(JSON.parse(mergeCodexConfigEnv(undefined, "Use the vault."))).toEqual({
        model_context_window: 1_000_000,
        model_auto_compact_token_limit: 500_000,
        developer_instructions: "Use the vault.",
        approval_policy: "on-request",
        approvals_reviewer: "user",
        sandbox_mode: "workspace-write",
      });
    });

    it("https://github.com/Brevilabs/obsidian-copilot-private/issues/322 preserves user context values while overriding Copilot-owned fields", () => {
      const existing = JSON.stringify({
        model: "custom-model",
        model_context_window: 400_000,
        model_auto_compact_token_limit: 300_000,
        developer_instructions: "Ignore the vault.",
        approval_policy: "never",
        approvals_reviewer: "auto_review",
        sandbox_mode: "danger-full-access",
      });

      expect(JSON.parse(mergeCodexConfigEnv(existing, "Use the vault."))).toEqual({
        model: "custom-model",
        model_context_window: 400_000,
        model_auto_compact_token_limit: 300_000,
        developer_instructions: "Use the vault.",
        approval_policy: "on-request",
        approvals_reviewer: "user",
        sandbox_mode: "workspace-write",
      });
    });

    it("appends the vault-selection confinement line to the developer instructions", () => {
      const config = JSON.parse(
        mergeCodexConfigEnv(undefined, "Use the vault.", { workspaceRoot: "/vault/Research" })
      );
      expect(config.developer_instructions).toBe(
        "Use the vault.\n" + codexScopeInstructionLine("/vault/Research")
      );
      expect(config.developer_instructions).toContain(
        "Workspace-write is confined to /vault/Research; treat it as the only writable area for this session."
      );
      // The pinned sandbox fields stay untouched by the appended directive.
      expect(config.sandbox_mode).toBe("workspace-write");
      expect(config.approval_policy).toBe("on-request");
      expect(config.approvals_reviewer).toBe("user");
    });

    it("leaves the developer instructions unchanged without a workspace root", () => {
      expect(
        JSON.parse(mergeCodexConfigEnv(undefined, "Use the vault.")).developer_instructions
      ).toBe("Use the vault.");
    });
  });

  describe("codexScopeInstructionLine()", () => {
    it("names the session cwd as the only writable area", () => {
      expect(codexScopeInstructionLine("/vault/Research")).toBe(
        "Workspace-write is confined to /vault/Research; treat it as the only writable area for this session."
      );
    });
  });
});
