import {
  agentScopeSignature,
  agentScopeWorkspaceFolderRoot,
  agentScopeWorkspaceRoot,
  computeAgentScope,
  getActiveAgentScope,
  setActiveAgentScope,
  type AgentScope,
} from "./agentScope";

/** Build a scope directly for workspace-root math without a full computation. */
function scopeWithFolders(folders: string[]): AgentScope {
  return {
    vaultRelativeFiles: new Set(),
    vaultRelativeFolders: new Set(folders),
    absoluteFolders: new Set(),
  };
}

describe("agentScope", () => {
  describe("computeAgentScope()", () => {
    const inventory = ["Research/paper.md", "Notes/todo.md"];

    it("returns null for an empty selection", () => {
      expect(computeAgentScope({}, "/vault")).toBeNull();
      expect(computeAgentScope({ contextNotes: [], contextFolders: [] }, "/vault")).toBeNull();
    });

    it("keeps exact current-vault files and dedupes repeats", () => {
      const scope = computeAgentScope(
        { contextNotes: [{ path: "Research/paper.md" }, { path: "Research/paper.md" }] },
        "/vault",
        { availableFilePaths: inventory }
      );
      expect([...(scope?.vaultRelativeFiles ?? [])]).toEqual(["Research/paper.md"]);
      expect(scope?.vaultRelativeFolders.size).toBe(0);
      expect(scope?.absoluteFolders.size).toBe(0);
    });

    it("drops file references the vault inventory does not know", () => {
      const scope = computeAgentScope(
        { contextNotes: [{ path: "Research/paper.md" }, { path: "deleted.md" }] },
        "/vault",
        { availableFilePaths: inventory }
      );
      expect([...(scope?.vaultRelativeFiles ?? [])]).toEqual(["Research/paper.md"]);
    });

    it("drops lexically unsafe file paths instead of widening the scope", () => {
      const scope = computeAgentScope(
        {
          contextNotes: [
            { path: "../outside.md" },
            { path: "/Users/me/secret.md" },
            { path: "back\\slash.md" },
          ],
        },
        "/vault",
        { availableFilePaths: inventory }
      );
      expect(scope).toBeNull();
    });

    it("normalizes folder selections (trailing slash, vault root) into prefixes", () => {
      const scope = computeAgentScope({ contextFolders: ["Research/", "/", "Notes"] }, "/vault", {
        availableFilePaths: inventory,
      });
      expect([...(scope?.vaultRelativeFolders ?? [])]).toEqual(["Research", "", "Notes"]);
      expect(scope?.vaultRelativeFiles.size).toBe(0);
    });

    it("projects selected folders onto absolute paths under the vault root", () => {
      const scope = computeAgentScope({ contextFolders: ["Research"] }, "/vault", {
        availableFilePaths: inventory,
      });
      expect([...(scope?.absoluteFolders ?? [])]).toEqual(["/vault/Research"]);
    });

    it("treats a stale folder selection as a harmless empty scope over files", () => {
      // Folders are prefixes, not inventory checks: a valid folder with no
      // files stays selectable.
      const scope = computeAgentScope({ contextFolders: ["Empty"] }, "/vault", {
        availableFilePaths: inventory,
      });
      expect([...(scope?.vaultRelativeFolders ?? [])]).toEqual(["Empty"]);
      expect(scope?.absoluteFolders).toEqual(new Set(["/vault/Empty"]));
    });

    it("carries files and folders in one scope when both are selected", () => {
      const scope = computeAgentScope(
        {
          contextNotes: [{ path: "Notes/todo.md" }],
          contextFolders: ["Research"],
        },
        "/vault",
        { availableFilePaths: inventory }
      );
      expect([...(scope?.vaultRelativeFiles ?? [])]).toEqual(["Notes/todo.md"]);
      expect([...(scope?.vaultRelativeFolders ?? [])]).toEqual(["Research"]);
      expect([...(scope?.absoluteFolders ?? [])]).toEqual(["/vault/Research"]);
    });

    it("resolves note paths against the provided note paths themselves when no inventory is given", () => {
      const scope = computeAgentScope(
        { contextNotes: [{ path: "Research/paper.md" }, { path: "../escape.md" }] },
        "/vault"
      );
      expect([...(scope?.vaultRelativeFiles ?? [])]).toEqual(["Research/paper.md"]);
    });
  });

  describe("agentScopeWorkspaceRoot()", () => {
    it("answers the vault root for a files-only scope (no folders selected)", () => {
      expect(agentScopeWorkspaceRoot(scopeWithFolders([]), "/vault")).toBe("/vault");
    });

    it("answers the single selected folder verbatim", () => {
      expect(agentScopeWorkspaceRoot(scopeWithFolders(["Research"]), "/vault")).toBe(
        "/vault/Research"
      );
      expect(agentScopeWorkspaceRoot(scopeWithFolders(["a/b/c"]), "/vault")).toBe("/vault/a/b/c");
    });

    it("answers the deepest common ancestor of sibling selections", () => {
      expect(agentScopeWorkspaceRoot(scopeWithFolders(["a/b/x", "a/b/y"]), "/vault")).toBe(
        "/vault/a/b"
      );
      expect(agentScopeWorkspaceRoot(scopeWithFolders(["a/b", "a/c"]), "/vault")).toBe("/vault/a");
    });

    it("answers the vault root when selections share no ancestor", () => {
      expect(agentScopeWorkspaceRoot(scopeWithFolders(["a/b", "x/y"]), "/vault")).toBe("/vault");
    });

    it("answers the vault root when the vault root itself is selected", () => {
      expect(agentScopeWorkspaceRoot(scopeWithFolders([""]), "/vault")).toBe("/vault");
    });

    it("strips a trailing separator from the vault root before joining", () => {
      expect(agentScopeWorkspaceRoot(scopeWithFolders(["Research"]), "/vault/")).toBe(
        "/vault/Research"
      );
    });
  });

  describe("agentScopeWorkspaceFolderRoot()", () => {
    it("returns the vault-relative forms, with the empty string for the vault root", () => {
      expect(agentScopeWorkspaceFolderRoot(scopeWithFolders([]))).toBe("");
      expect(agentScopeWorkspaceFolderRoot(scopeWithFolders(["Research"]))).toBe("Research");
      expect(agentScopeWorkspaceFolderRoot(scopeWithFolders(["a/b/x", "a/b/y"]))).toBe("a/b");
      expect(agentScopeWorkspaceFolderRoot(scopeWithFolders(["a/b", "x/y"]))).toBe("");
    });
  });

  describe("agentScopeSignature()", () => {
    it("compares equal for the same selection computed twice (fresh Set instances)", () => {
      const a = computeAgentScope(
        { contextFolders: ["Research"], contextNotes: [{ path: "Notes/todo.md" }] },
        "/vault",
        { availableFilePaths: ["Notes/todo.md"] }
      );
      const b = computeAgentScope(
        { contextFolders: ["Research"], contextNotes: [{ path: "Notes/todo.md" }] },
        "/vault",
        { availableFilePaths: ["Notes/todo.md"] }
      );
      expect(a).not.toBe(b);
      expect(agentScopeSignature(a!)).toBe(agentScopeSignature(b!));
    });

    it("differs when either dimension changes", () => {
      const filesOnly = computeAgentScope({ contextNotes: [{ path: "Notes/todo.md" }] }, "/vault", {
        availableFilePaths: ["Notes/todo.md"],
      });
      const withFolder = computeAgentScope(
        { contextFolders: ["Research"], contextNotes: [{ path: "Notes/todo.md" }] },
        "/vault",
        { availableFilePaths: ["Notes/todo.md"] }
      );
      expect(agentScopeSignature(filesOnly!)).not.toBe(agentScopeSignature(withFolder!));
    });
  });

  describe("setActiveAgentScope()/getActiveAgentScope()", () => {
    afterEach(() => setActiveAgentScope(null));

    it("publishes the latest selection and clears on null", () => {
      expect(getActiveAgentScope()).toBeNull();
      const scope = computeAgentScope({ contextFolders: ["Research"] }, "/vault", {
        availableFilePaths: [],
      });
      setActiveAgentScope(scope);
      expect(getActiveAgentScope()).toBe(scope);
      setActiveAgentScope(null);
      expect(getActiveAgentScope()).toBeNull();
    });
  });
});
