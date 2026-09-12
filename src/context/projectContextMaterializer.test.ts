import { FileSystemAdapter, TFolder, type App } from "obsidian";
import type { ContextCacheFs } from "./contextCacheFs";

// In-memory fs injected in place of the node cache fs.
let mockFs: ContextCacheFs & { files: Map<string, string> };

jest.mock("./contextCacheFs", () => ({
  createNodeContextCacheFs: () => mockFs,
}));

jest.mock("@/projects/state", () => ({
  getCachedProjectRecordById: jest.fn(),
}));
jest.mock("@/search/searchUtils", () => ({
  getMatchingPatterns: jest.fn(),
  shouldIndexFile: jest.fn(() => true),
}));
// The signature helper pulls "@/utils" in transitively (via the Copilot folder
// settings); the real module is out of this suite's scope, so stub the one
// function the reachable paths need.
jest.mock("@/utils", () => ({
  ensureFolderExists: jest.fn(async () => undefined),
}));

import { getCachedProjectRecordById } from "@/projects/state";
import { getMatchingPatterns, shouldIndexFile } from "@/search/searchUtils";
import { cacheFileName } from "./contextCacheStore";
import {
  ensureProjectContextMaterialized,
  materializeProjectContextSource,
  type ContextMaterializeProgress,
} from "./projectContextMaterializer";

const getRecord = getCachedProjectRecordById as jest.Mock;
const getPatterns = getMatchingPatterns as jest.Mock;
const indexFile = shouldIndexFile as jest.Mock;

const CWD = "/vault/Proj";
// Cache writes go to the SHARED off-vault cache (node-fs backed, mocked here by
// the in-memory `mockFs`). The store receives cache-root-relative dirs derived by
// the materializer: `remotes/`, `files/`, and a per-project `markers/<md5(projectId)>/`.
// The agent-facing absolute folder/note paths still come from `getFullPath` and
// are asserted as `/vault/...` below.

/**
 * Optional in-flight gate. When set, the in-memory fs AWAITS `promise` before
 * reading/writing any path `match` accepts — the knob that used to be a gated
 * relay fetch, letting a test hold one source's read-decide-write mid-flight
 * inside the per-artifact lock.
 */
let fsGate: { match: (p: string) => boolean; promise: Promise<void> } | null = null;

function memFs(): ContextCacheFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const gated = async (p: string) => {
    if (fsGate && fsGate.match(p)) await fsGate.promise;
  };
  return {
    files,
    exists: async (p) => files.has(p),
    mkdirRecursive: async () => undefined,
    list: async (dir) => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return [...files.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        .filter((n) => !n.includes("/"));
    },
    readText: async (p) => {
      await gated(p);
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p)!;
    },
    writeText: async (p, c) => {
      await gated(p);
      files.set(p, c);
    },
    remove: async (p) => void files.delete(p),
  };
}

function record(contextSource: Record<string, string | undefined>, id = "p1") {
  return { project: { id, contextSource }, filePath: "Proj/AGENTS.md", folderName: "Proj" };
}

const flushMicrotasks = () => new Promise((resolve) => window.setTimeout(resolve, 0));

function patterns(over: Record<string, string[]> = {}) {
  return {
    inclusions: { folderPatterns: [], notePatterns: [], extensionPatterns: [], tagPatterns: [], ...over }, // prettier-ignore
    exclusions: null,
  };
}

function fakeApp(files: Array<{ path: string; ext: string }> = [], folders: string[] = []): App {
  const tfiles = files.map((f) => ({
    path: f.path,
    extension: f.ext,
    basename: f.path
      .split("/")
      .pop()!
      .replace(/\.[^.]+$/, ""),
    stat: { mtime: 1000, size: 10 },
  }));
  const folderSet = new Set(folders);
  const FsAdapter = FileSystemAdapter as unknown as new (basePath: string) => FileSystemAdapter;
  const Folder = TFolder as unknown as new (path: string) => TFolder;
  return {
    vault: {
      adapter: new FsAdapter("/vault"),
      getFiles: () => tfiles,
      getMarkdownFiles: () => tfiles.filter((f) => f.extension === "md"),
      getAbstractFileByPath: (p: string) => (folderSet.has(p) ? new Folder(p) : null),
      readBinary: jest.fn(async () => new ArrayBuffer(4)),
    },
  } as unknown as App;
}

beforeEach(() => {
  mockFs = memFs();
  fsGate = null;
  jest.clearAllMocks();
  getPatterns.mockReturnValue(patterns());
  // Reset the default so a per-test property matcher override never leaks forward.
  indexFile.mockReturnValue(true);
});

describe("ensureProjectContextMaterialized", () => {
  it("returns the frozen empty result when the project is unknown", async () => {
    getRecord.mockReturnValue(undefined);
    const result = await ensureProjectContextMaterialized(fakeApp(), "missing", CWD);
    expect(result.additionalDirectories).toEqual([]);
    // The caller asked for a project scope, so the workspace policy still has to arm even
    // though nothing about the project could be read.
    expect(result.projectContextBlock).toContain("project workspace");
    expect(result.contextSignature).toBeUndefined();
  });

  it("still emits a minimal project block when the project has no context sources", async () => {
    // The product prompt's workspace policy triggers on the block's presence (the prompt is
    // byte-identical across scopes), so a source-less project must announce itself or the
    // agent is never told to keep writes under the project's outputs/ folder.
    getRecord.mockReturnValue(record({}));
    const result = await ensureProjectContextMaterialized(fakeApp(), "p1", CWD);
    expect(result.additionalDirectories).toEqual([]);
    expect(result.projectContextBlock).toContain("<project_context>");
    expect(result.projectContextBlock).toContain("No context sources are configured");
    expect(mockFs.files.size).toBe(0);
  });

  it("marks a web URL source failed (no local converter) and still lists it in the block", async () => {
    getRecord.mockReturnValue(record({ webUrls: "https://example.com" }));
    const result = await ensureProjectContextMaterialized(fakeApp(), "p1", CWD);

    expect(result.projectContextBlock).toContain("<project_context>");
    expect(result.projectContextBlock).toContain("https://example.com");
    // No manifest file is written anywhere — context is inline in the prompt.
    expect([...mockFs.files.keys()].some((k) => k.endsWith("CONTEXT.md"))).toBe(false);
    // The conversion has no local provider: no snapshot, but a failure marker.
    expect([...mockFs.files.keys()].some((k) => k.startsWith("remotes/web-"))).toBe(false);
    expect([...mockFs.files.keys()].some((k) => k.includes("failed-web-"))).toBe(true);
  });

  it("reports only out-of-cwd folder inclusions as additional directories", async () => {
    getRecord.mockReturnValue(record({ inclusions: "External,Proj/Sub" }));
    getPatterns.mockReturnValue(patterns({ folderPatterns: ["External", "Proj/Sub"] }));
    const app = fakeApp([], ["External", "Proj/Sub"]);

    const result = await ensureProjectContextMaterialized(app, "p1", CWD);

    expect(result.additionalDirectories).toEqual(["/vault/External"]);
    // Both folders are listed in the block with absolute paths (add-dir is only
    // for the out-of-cwd one).
    expect(result.projectContextBlock).toContain("`/vault/External`");
    expect(result.projectContextBlock).toContain("`/vault/Proj/Sub`");
  });

  it("lists included notes by absolute path in the context block", async () => {
    getRecord.mockReturnValue(record({ inclusions: "[[Spec]]" }));
    getPatterns.mockReturnValue(patterns({ notePatterns: ["[[Spec]]"] }));
    const app = fakeApp([{ path: "Notes/Spec.md", ext: "md" }]);

    const result = await ensureProjectContextMaterialized(app, "p1", CWD);

    expect(result.projectContextBlock).toContain("## Included notes");
    expect(result.projectContextBlock).toContain("`/vault/Notes/Spec.md`");
  });

  it("lists every note that shares an inclusion title (basename collision)", async () => {
    getRecord.mockReturnValue(record({ inclusions: "[[Spec]]" }));
    getPatterns.mockReturnValue(patterns({ notePatterns: ["[[Spec]]"] }));
    const app = fakeApp([
      { path: "A/Spec.md", ext: "md" },
      { path: "B/Spec.md", ext: "md" },
    ]);

    const result = await ensureProjectContextMaterialized(app, "p1", CWD);

    expect(result.projectContextBlock).toContain("`/vault/A/Spec.md`");
    expect(result.projectContextBlock).toContain("`/vault/B/Spec.md`");
  });

  it("counts a property-only inclusion as a source and enumerates matching notes by absolute path", async () => {
    getRecord.mockReturnValue(record({ inclusions: "[Topics:Physics]" }));
    getPatterns.mockReturnValue(patterns({ propertyPatterns: ["[Topics:Physics]"] }));
    const app = fakeApp([
      { path: "Notes/Relativity.md", ext: "md" },
      { path: "Notes/Cooking.md", ext: "md" },
    ]);
    // Only the physics note carries the matching frontmatter property.
    indexFile.mockImplementation((_app: unknown, file: { path: string }) => file.path === "Notes/Relativity.md"); // prettier-ignore

    const result = await ensureProjectContextMaterialized(app, "p1", CWD);

    expect(result.projectContextBlock).toContain("<project_context>");
    // Property matches are an expansion, listed apart from the declared `[[note]]`
    // sources so they can never push one past the entry cap.
    expect(result.projectContextBlock).toContain("## Notes matching an included property");
    expect(result.projectContextBlock).toContain("`/vault/Notes/Relativity.md`");
    expect(result.projectContextBlock).not.toContain("Cooking");
  });

  it("lists a note reached by both a title and a property once, as a declaration", async () => {
    getRecord.mockReturnValue(record({ inclusions: "[[Relativity]],[Topics:Physics]" }));
    getPatterns.mockReturnValue(
      patterns({ notePatterns: ["[[Relativity]]"], propertyPatterns: ["[Topics:Physics]"] })
    );
    const app = fakeApp([{ path: "Notes/Relativity.md", ext: "md" }]);
    indexFile.mockReturnValue(true);

    const result = await ensureProjectContextMaterialized(app, "p1", CWD);

    const block = result.projectContextBlock ?? "";
    expect(block.match(/\/vault\/Notes\/Relativity\.md/g)).toHaveLength(1);
    // The declaration wins the row, so the note keeps its place among the sources
    // that survive the entry cap rather than trailing behind the expansions.
    expect(block).toContain("## Included notes");
    expect(block).not.toContain("## Notes matching an included property");
  });

  it("still emits <project_context> for a property-only project when no note currently matches", async () => {
    getRecord.mockReturnValue(record({ inclusions: "[Topics:Physics]" }));
    getPatterns.mockReturnValue(patterns({ propertyPatterns: ["[Topics:Physics]"] }));
    const app = fakeApp([{ path: "Notes/Cooking.md", ext: "md" }]);
    indexFile.mockReturnValue(false); // nothing matches the property yet

    const result = await ensureProjectContextMaterialized(app, "p1", CWD);

    // The declared property is a real source, so the block IS emitted (not the
    // frozen empty result) — otherwise a stale empty landing would be reused. It
    // simply lists no note until one matches.
    expect(result.projectContextBlock).toContain("<project_context>");
    expect(result.projectContextBlock).not.toContain("## Included notes");
  });

  it("marks non-text in-vault files failed but ignores markdown files", async () => {
    getRecord.mockReturnValue(record({ inclusions: "Proj" }));
    getPatterns.mockReturnValue(patterns({ folderPatterns: ["Proj"] }));
    const app = fakeApp([
      { path: "Proj/a.pdf", ext: "pdf" },
      { path: "Proj/note.md", ext: "md" },
    ]);

    const progress: ContextMaterializeProgress[] = [];
    await ensureProjectContextMaterialized(app, "p1", CWD, (p) => progress.push(p));

    // The PDF has no local converter on this path: it fails per-source, while
    // markdown is never queued for conversion.
    const failuresPhase = progress.find((p) => p.phase === "failures");
    expect(
      failuresPhase?.phase === "failures" &&
        failuresPhase.failures
          .map((f) => f.error)
          .every((e) => e.includes("No local document processor"))
    ).toBe(true);
    expect([...mockFs.files.keys()].some((k) => k.includes("/file-"))).toBe(false);
    expect([...mockFs.files.keys()].some((k) => k.includes("failed-file-"))).toBe(true);
  });

  it("reports resolve + per-loop progress through onProgress", async () => {
    getRecord.mockReturnValue(record({ inclusions: "Proj", webUrls: "https://example.com" }));
    getPatterns.mockReturnValue(patterns({ folderPatterns: ["Proj"] }));
    const app = fakeApp([{ path: "Proj/a.pdf", ext: "pdf" }]);

    const progress: ContextMaterializeProgress[] = [];
    await ensureProjectContextMaterialized(app, "p1", CWD, (p) => progress.push(p));

    // Resolve fires first, counting the one materialize-eligible binary file.
    expect(progress[0]).toEqual({ phase: "resolve", resolved: 1 });
    expect(progress).toContainEqual({ phase: "prefetch", done: 1, total: 1 });
    expect(progress).toContainEqual({ phase: "parse", done: 1, total: 1 });
  });

  it("never rejects when a remote source cannot be converted", async () => {
    getRecord.mockReturnValue(record({ webUrls: "https://broken.com" }));

    const result = await ensureProjectContextMaterialized(fakeApp(), "p1", CWD);
    // Degrades gracefully: block still built, no snapshot written, never throws.
    expect(result.projectContextBlock).toContain("https://broken.com");
    expect([...mockFs.files.keys()].some((k) => k.startsWith("remotes/web-"))).toBe(false);
    // No manifest file is written.
    expect([...mockFs.files.keys()].some((k) => k.endsWith("CONTEXT.md"))).toBe(false);
  });

  it("returns the frozen empty result if a filesystem write throws", async () => {
    getRecord.mockReturnValue(record({ webUrls: "https://example.com" }));
    // mkdir is awaited outside the per-source try/catch, so a hard fs failure
    // propagates to the never-reject guard and degrades to the empty result.
    mockFs.mkdirRecursive = jest.fn(async () => {
      throw new Error("EACCES");
    });

    const result = await ensureProjectContextMaterialized(fakeApp(), "p1", CWD);
    expect(result.additionalDirectories).toEqual([]);
    // The block still announces the workspace: the product prompt's workspace policy triggers
    // on its presence, so dropping it would stop telling the agent to keep writes under the
    // project's `outputs/` folder — a broken context load must not widen where it writes.
    expect(result.projectContextBlock).toContain("project workspace");
    expect(result.projectContextBlock).toContain("could not be loaded");
    // Still no signature, so a caller's dirty flag survives a run that captured nothing.
    expect(result.contextSignature).toBeUndefined();
  });
});

describe("ensureProjectContextMaterialized — single-flight", () => {
  it("dedupes concurrent calls for the same project to one run", async () => {
    getRecord.mockReturnValue(record({ webUrls: "https://a.com" }));
    const app = fakeApp();
    // Hold the first run mid-upsert (inside the per-artifact lock) so the second
    // call arrives while it is genuinely in flight.
    let release!: () => void;
    fsGate = {
      match: (p) => p.includes(cacheFileName("web", "https://a.com")),
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };

    const a = ensureProjectContextMaterialized(app, "p1", CWD);
    await flushMicrotasks(); // A reaches its gated meta read, still in flight
    const b = ensureProjectContextMaterialized(app, "p1", CWD); // joins A
    release();

    const [r1, r2] = await Promise.all([a, b]);
    expect(r1).toBe(r2); // both awaited the same in-flight promise
  });

  it("does not serialize different projects with DIFFERENT sources", async () => {
    // Distinct URLs per project: the per-project single-flight doesn't block them
    // and they don't collide on the global per-artifact lock (different keys).
    // p1's upsert is held in flight; p2 must still settle BEFORE it is released.
    getRecord.mockImplementation((id: string) =>
      record({ webUrls: id === "p1" ? "https://p1.com" : "https://p2.com" }, id)
    );
    let release!: () => void;
    fsGate = {
      match: (p) => p.includes(cacheFileName("web", "https://p1.com")),
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };

    const p1 = ensureProjectContextMaterialized(fakeApp(), "p1", "/vault/P1");
    const p2 = ensureProjectContextMaterialized(fakeApp(), "p2", "/vault/P2");

    // p2 settles while p1 is still gated — they never serialize.
    const r2 = await p2;
    expect(r2.projectContextBlock).toContain("https://p2.com");

    release();
    const r1 = await p1;
    expect(r1.projectContextBlock).toContain("https://p1.com");
  });

  it("gives two projects converting the SAME url one shared per-artifact lock (no overwrite race)", async () => {
    // Same URL across two distinct projects → same snapshot file name → same
    // global mutex. The first run holds the shared meta read in flight; the
    // second waits on the lock instead of racing the same cache files. (The OLD
    // behavior fetched twice in parallel.)
    getRecord.mockImplementation((id: string) => record({ webUrls: "https://shared.com" }, id));
    let release!: () => void;
    fsGate = {
      match: (p) => p.startsWith("remotes/web-"),
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };

    const a = ensureProjectContextMaterialized(fakeApp(), "pA", "/vault/PA");
    await flushMicrotasks(); // A acquires the lock and reaches the gated meta read
    const b = ensureProjectContextMaterialized(fakeApp(), "pB", "/vault/PB");
    release();
    await Promise.all([a, b]);

    // Both runs mark the source failed per-project; no shared snapshot exists.
    expect([...mockFs.files.keys()].some((k) => k.startsWith("remotes/web-"))).toBe(false);
    const markers = [...mockFs.files.keys()].filter((k) => k.includes("failed-web-"));
    expect(markers).toHaveLength(2); // one per project
  });

  it("clears the in-flight entry so a later call re-evaluates fresh state", async () => {
    const app = fakeApp();
    getRecord.mockReturnValue(record({ webUrls: "https://a.com" }));
    const r1 = await ensureProjectContextMaterialized(app, "p1", CWD);

    // After the first run settled, the source changed — a fresh call must run
    // again (not return the prior settled promise) and process the NEW source.
    getRecord.mockReturnValue(record({ webUrls: "https://b.com" }));
    const r2 = await ensureProjectContextMaterialized(app, "p1", CWD);

    expect(r2).not.toBe(r1);
    expect(r2.contextSignature).not.toBe(r1.contextSignature);
    expect(
      [...mockFs.files.keys()].some(
        (k) => k.includes("failed-web-") && mockFs.files.get(k)!.includes("https://b.com")
      )
    ).toBe(true);
  });

  it("supersedes an in-flight run whose source set was edited (a later caller must not join the stale run)", async () => {
    const app = fakeApp();
    // Run A materializes source A; gate its upsert so it stays in flight.
    getRecord.mockReturnValue(record({ webUrls: "https://a.com" }));
    let release!: () => void;
    fsGate = {
      match: (p) => p.startsWith("remotes/web-"),
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };

    const a = ensureProjectContextMaterialized(app, "p1", CWD); // non-force, signature S1
    await flushMicrotasks(); // A reaches the gated read, still in flight

    // The project's context is edited mid-flight → new source set → new signature.
    getRecord.mockReturnValue(record({ webUrls: "https://b.com" }));
    const progressB: ContextMaterializeProgress[] = [];
    const b = ensureProjectContextMaterialized(app, "p1", CWD, (p) => progressB.push(p)); // signature S2

    release(); // let A settle; B's deferred run then materializes the NEW source
    const [aRes, bRes] = await Promise.all([a, b]);

    // B did NOT join the stale run — it superseded and captured the edited sources.
    expect(bRes).not.toBe(aRes);
    const failuresB = progressB.find((p) => p.phase === "failures");
    expect(
      failuresB?.phase === "failures" &&
        failuresB.failures.some((f) => f.source === "https://b.com")
    ).toBe(true);
  });

  it("supersedes an in-flight run when a caller passes a NEWER revisionKey (same config signature)", async () => {
    const app = fakeApp();
    // The config signature never changes here (same sources); only the content
    // revision key differs — the case a pure file edit produces.
    getRecord.mockReturnValue(record({ webUrls: "https://a.com" }));
    let release!: () => void;
    fsGate = {
      match: (p) => p.startsWith("remotes/web-"),
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };

    // A runs at revision epoch 0; hold it in flight.
    const a = ensureProjectContextMaterialized(app, "p1", CWD, undefined, undefined, "sig#0");
    await flushMicrotasks();
    // A content edit bumped the epoch → B wants revision epoch 1 and must NOT join A.
    const b = ensureProjectContextMaterialized(app, "p1", CWD, undefined, undefined, "sig#1");

    release();
    const [aRes, bRes] = await Promise.all([a, b]);

    // Distinct result objects prove B ran its OWN materialization (superseded)
    // rather than joining A's in-flight promise.
    expect(bRes).not.toBe(aRes);
  });

  it("still dedupes concurrent callers that share the same revisionKey", async () => {
    getRecord.mockReturnValue(record({ webUrls: "https://a.com" }));
    const app = fakeApp();
    let release!: () => void;
    fsGate = {
      match: (p) => p.startsWith("remotes/web-"),
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };

    const a = ensureProjectContextMaterialized(app, "p1", CWD, undefined, undefined, "sig#7");
    await flushMicrotasks(); // A is in flight
    const b = ensureProjectContextMaterialized(app, "p1", CWD, undefined, undefined, "sig#7"); // joins A
    release();

    const [r1, r2] = await Promise.all([a, b]);
    expect(r1).toBe(r2); // one run, joined
  });
});

describe("Option D — failure markers, forced retry, single-source reconcile", () => {
  it("cheap-skips a known-bad source on the next automatic run (no re-attempt)", async () => {
    const app = fakeApp();
    getRecord.mockReturnValue(record({ webUrls: "https://a.com" }));

    await ensureProjectContextMaterialized(app, "p1", CWD);
    expect([...mockFs.files.keys()].some((k) => k.includes("failed-web-"))).toBe(true);

    // Second automatic pass: the failure marker is honored — no attempt begins —
    // yet the failure is still surfaced through onProgress.
    const progress: ContextMaterializeProgress[] = [];
    await ensureProjectContextMaterialized(app, "p1", CWD, (p) => progress.push(p));

    expect(progress.some((p) => p.phase === "itemStart")).toBe(false); // never re-attempted
    const failures = progress.find((p) => p.phase === "failures");
    expect(failures?.phase === "failures" && failures.failures).toHaveLength(1);
  });

  it("materializeProjectContextSource forces a retry past the failure marker", async () => {
    const app = fakeApp();
    getRecord.mockReturnValue(record({ webUrls: "https://a.com" }));
    await ensureProjectContextMaterialized(app, "p1", CWD);
    expect([...mockFs.files.keys()].some((k) => k.includes("failed-web-"))).toBe(true);

    // The single-source Retry forces a fresh attempt even though the marker is
    // on disk (the automatic path above cheap-skipped it). The converter still
    // has no local provider, so the retry re-records the failure — observable as
    // a SECOND marker write that a cheap-skip would never make.
    const markerWrites = jest.spyOn(mockFs, "writeText");
    const failures = await materializeProjectContextSource(app, "p1", {
      kind: "web",
      source: "https://a.com",
    });

    expect(markerWrites.mock.calls.filter(([p]) => String(p).includes("failed-web-"))).toHaveLength(
      1
    );
    expect(failures).toHaveLength(1);
    expect([...mockFs.files.keys()].some((k) => k.includes("failed-web-"))).toBe(true);
    // No snapshot was ever produced for the source.
    expect([...mockFs.files.keys()].some((k) => k.includes("/web-"))).toBe(false);
  });

  it("a forced retry supersedes an in-flight non-force warm; later joiners get the forced result", async () => {
    const app = fakeApp();

    // Phase 1: source A fails on the automatic path → marker, no snapshot.
    getRecord.mockReturnValue(record({ webUrls: "https://a.com" }));
    await ensureProjectContextMaterialized(app, "p1", CWD);
    expect([...mockFs.files.keys()].some((k) => k.includes("failed-web-"))).toBe(true);

    // Phase 2: the source set now also has B (e.g. a source edit kicked off a
    // warm). The warm is non-force, so it cheap-skips A's marker and only
    // attempts B — hold B's upsert in flight so the forced retry arrives while
    // the warm is still running.
    getRecord.mockReturnValue(record({ webUrls: "https://a.com\nhttps://b.com" }));
    let release!: () => void;
    fsGate = {
      match: (p) => p.includes(cacheFileName("web", "https://b.com")),
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };

    const warmProgress: ContextMaterializeProgress[] = [];
    const warm = ensureProjectContextMaterialized(app, "p1", CWD, (p) => warmProgress.push(p)); // non-force
    await flushMicrotasks(); // the warm reaches its gated B upsert
    const forcedProgress: ContextMaterializeProgress[] = [];
    const forced = ensureProjectContextMaterialized(
      app,
      "p1",
      CWD,
      (p) => forcedProgress.push(p),
      true
    );
    const joiner = ensureProjectContextMaterialized(app, "p1", CWD); // non-force, lands after the force
    release();

    const [warmRes, forcedRes, joinerRes] = await Promise.all([warm, forced, joiner]);
    // Resolved-value identity (the fn is async, so promise refs always differ):
    // a later non-force caller joins the FORCED run, not the stale warm — so a
    // session-create / landing-refresh after Retry captures the forced result.
    expect(joinerRes).toBe(forcedRes);
    expect(joinerRes).not.toBe(warmRes);

    // The forced pass re-attempted A past its marker (a non-force warm would
    // have cheap-skipped it), while the warm only ever started B.
    const started = (progress: ContextMaterializeProgress[]) =>
      progress
        .filter((p) => p.phase === "itemStart")
        .map((p) => (p.phase === "itemStart" && p.item.source) || "");
    expect(started(forcedProgress)).toContain("https://a.com");
    expect(started(warmProgress)).not.toContain("https://a.com");
  });

  it("a concurrent full run does not duplicate or clobber a single-source retry (per-artifact lock)", async () => {
    // The retry + full run serialize on the per-artifact lock for the same URL —
    // so the retry's outcome survives and the full run cheap-skips instead of
    // double-attempting the source.
    const app = fakeApp();
    getRecord.mockReturnValue(record({ webUrls: "https://a.com" }));

    // 1. First automatic run fails → marker on disk, no snapshot.
    await ensureProjectContextMaterialized(app, "p1", CWD);
    expect([...mockFs.files.keys()].some((k) => k.includes("failed-web-"))).toBe(true);

    // 2. Gate the retry's marker WRITE so it holds the per-artifact lock
    //    mid-write-window (the equivalent of the old gated fetch).
    let releaseWrite!: () => void;
    fsGate = {
      match: (p) => p.includes("failed-web-"),
      promise: new Promise<void>((resolve) => {
        releaseWrite = resolve;
      }),
    };
    const retry = materializeProjectContextSource(app, "p1", { kind: "web", source: "https://a.com" }); // prettier-ignore
    await flushMicrotasks(); // the retry acquires the lock and reaches its gated write

    // 3. A full run starts during the retry's write window. Its upsert for the
    //    same URL waits on the same per-artifact lock rather than re-attempting.
    const fullProgress: ContextMaterializeProgress[] = [];
    const full = ensureProjectContextMaterialized(app, "p1", CWD, (p) => fullProgress.push(p));
    await flushMicrotasks();

    // 4. Release the retry; both settle.
    releaseWrite();
    const [retryFailures, fullRes] = await Promise.all([retry, full]);

    // 5. No snapshot exists (no local converter), but the failure marker
    //    survived the racing full run, which cheap-skipped it.
    expect(retryFailures).toHaveLength(1);
    expect([...mockFs.files.keys()].some((k) => k.startsWith("remotes/web-"))).toBe(false);
    expect([...mockFs.files.keys()].some((k) => k.includes("failed-web-"))).toBe(true);
    const fullFailures = fullProgress.find((p) => p.phase === "failures");
    expect(fullFailures?.phase === "failures" && fullFailures.failures).toHaveLength(1);
    expect(fullRes.contextSignature).toBeDefined();
  });
});
