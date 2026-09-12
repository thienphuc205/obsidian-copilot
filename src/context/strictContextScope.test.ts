import {
  buildStrictContextScope,
  filterFilesToStrictContext,
  filterFilesToStrictFolders,
  isPathInStrictFolderScope,
  normalizeStrictVaultPath,
} from "./strictContextScope";

describe("normalizeStrictVaultPath", () => {
  it("keeps ordinary vault-relative paths and normalizes a folder trailing slash", () => {
    expect(normalizeStrictVaultPath("Notes/one.md")).toBe("Notes/one.md");
    expect(normalizeStrictVaultPath("Notes/", { allowRoot: true })).toBe("Notes");
    expect(normalizeStrictVaultPath("/", { allowRoot: true })).toBe("");
  });

  it.each([
    "",
    " ",
    "/etc/passwd",
    "C:/outside.md",
    "\\\\server\\share",
    "a\\b.md",
    "a//b.md",
    "a/./b.md",
    "a/../b.md",
  ])("rejects unsafe path %j", (path) => {
    expect(normalizeStrictVaultPath(path)).toBeNull();
  });

  it("does not treat a folder's sibling with a shared prefix as in-scope", () => {
    const folders = new Set(["Research"]);
    expect(isPathInStrictFolderScope("Research/paper.md", folders)).toBe(true);
    expect(isPathInStrictFolderScope("Research-old/paper.md", folders)).toBe(false);
  });
});

describe("buildStrictContextScope", () => {
  const available = ["Notes/one.md", "Research/paper.md", "Research/assets/chart.png"];

  it("accepts exact current-vault files and valid folders while deduplicating", () => {
    const result = buildStrictContextScope(
      [{ path: "Notes/one.md" }, { path: "Notes/one.md" }],
      [{ path: "Research" }, { path: "Research/" }],
      available
    );

    expect([...result.scope.filePaths]).toEqual(["Notes/one.md"]);
    expect([...result.scope.folderPaths]).toEqual(["Research"]);
    expect(result.rejected).toEqual([]);
  });

  it("rejects stale and traversal file references without widening the scope", () => {
    const result = buildStrictContextScope(
      [{ path: "missing.md" }, { path: "../Research/paper.md" }, { path: "/Users/me/secret.md" }],
      [],
      available
    );

    expect([...result.scope.filePaths]).toEqual([]);
    expect(result.rejected).toEqual([
      { kind: "file", value: "missing.md", reason: "not-in-vault" },
      { kind: "file", value: "../Research/paper.md", reason: "invalid-path" },
      { kind: "file", value: "/Users/me/secret.md", reason: "invalid-path" },
    ]);
  });

  it("keeps a root-folder selection explicit and bounded to the supplied inventory", () => {
    const result = buildStrictContextScope([], ["/"], available);
    expect(
      filterFilesToStrictContext(
        available.map((path) => ({ path })),
        result.scope
      )
    ).toEqual(available.map((path) => ({ path })));
  });
});

describe("strict context file filters", () => {
  const files = [
    { path: "Research/paper.md", id: 1 },
    { path: "Research-old/paper.md", id: 2 },
    { path: "Notes/one.md", id: 3 },
  ];

  it("returns only the exact file/folder union in source order", () => {
    const result = buildStrictContextScope(
      [{ path: "Notes/one.md" }],
      [{ path: "Research" }],
      files.map((file) => file.path)
    );

    expect(filterFilesToStrictContext(files, result.scope).map((file) => file.id)).toEqual([1, 3]);
    expect(
      filterFilesToStrictFolders(files, result.scope.folderPaths).map((file) => file.id)
    ).toEqual([1]);
  });
});
