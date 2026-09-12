import {
  BUILTIN_SKILLS,
  MIYO_PARSE_SKILL,
  MIYO_SEARCH_SKILL,
  planManagedBuiltins,
} from "./builtinSkills";

describe("builtinSkills", () => {
  describe("BUILTIN_SKILLS", () => {
    it("ships the Obsidian and workflow skills to all three agents", () => {
      expect(BUILTIN_SKILLS.map((s) => s.name)).toEqual([
        "research",
        "read-scanned-pdf",
        "youtube-notes",
        "read-files",
        "study-quiz",
        "feynman-grade",
        "defense-sim",
        "paper-companion",
        "obsidian-markdown",
        "obsidian-bases",
        "json-canvas",
        "obsidian-cli",
      ]);
      for (const skill of BUILTIN_SKILLS) {
        expect(skill.enabledAgents).toEqual(["claude", "codex", "opencode"]);
      }
    });

    it("keeps the SKILL.md frontmatter version in sync with the numeric version", () => {
      for (const skill of BUILTIN_SKILLS) {
        expect(skill.skillMd).toContain(`copilot-builtin-version: "${skill.version}"`);
      }
    });
  });

  describe("MIYO_SEARCH_SKILL", () => {
    it("is a separate, Miyo-gated skill — not one of the always-seeded builtins", () => {
      expect(BUILTIN_SKILLS.map((s) => s.name)).not.toContain("miyo-search");
      expect(MIYO_SEARCH_SKILL.name).toBe("miyo-search");
      expect(MIYO_SEARCH_SKILL.enabledAgents).toEqual(["claude", "codex", "opencode"]);
    });

    const miyoScript = (ext: ".sh" | ".cmd"): string => {
      const file = MIYO_SEARCH_SKILL.files.find((f) => f.path.endsWith(ext));
      if (!file) throw new Error(`miyo-search ships no ${ext} script`);
      return file.content;
    };

    it("ships exactly two OS wrappers — POSIX sh + Windows cmd, no Node", () => {
      expect(MIYO_SEARCH_SKILL.files.map((f) => f.path)).toEqual([
        "miyo-search.sh",
        "miyo-search.cmd",
      ]);
      expect(MIYO_SEARCH_SKILL.skillMd).toContain(
        `sh "/absolute/path/to/this/skill/directory/miyo-search.sh"`
      );
      // Windows is shown with the PowerShell call operator `&` (a bare quoted
      // path is a string in PowerShell and wouldn't run).
      expect(MIYO_SEARCH_SKILL.skillMd).toContain(
        `& "/absolute/path/to/this/skill/directory/miyo-search.cmd"`
      );
      // No Node runtime anywhere — neither a .mjs file nor a node invocation.
      expect(MIYO_SEARCH_SKILL.files.some((f) => f.path.endsWith(".mjs"))).toBe(false);
      expect(MIYO_SEARCH_SKILL.skillMd).not.toContain("node ");
    });

    it("keeps the SKILL.md frontmatter version in sync with the numeric version", () => {
      expect(MIYO_SEARCH_SKILL.skillMd).toContain(
        `copilot-builtin-version: "${MIYO_SEARCH_SKILL.version}"`
      );
    });

    it("documents concrete triggers for when to call it", () => {
      const md = MIYO_SEARCH_SKILL.skillMd;
      // The description is the agent's primary "when to use" signal.
      expect(md).toMatch(/description:[^\n]*too slow/i);
      expect(md).toMatch(/description:[^\n]*vault-search intent/i);
      // The body reinforces the same triggers.
      expect(md).toMatch(/When to use it/);
      expect(md).toMatch(/doesn't surface enough relevant notes/i);
    });

    it("runs one deterministic `miyo search ... --json` in each script", () => {
      expect(miyoScript(".sh")).toContain('search "$QUERY"');
      expect(miyoScript(".sh")).toContain("--json");
      expect(miyoScript(".cmd")).toContain("search %* -n 10 --json");
    });

    it("https://github.com/Brevilabs/obsidian-copilot-private/issues/121 passes the exact active-vault identity in Current vault mode on POSIX and Windows", () => {
      const sh = miyoScript(".sh");
      const cmd = miyoScript(".cmd");

      expect(sh).toContain('case "${COPILOT_MIYO_SEARCH_SCOPE:-current}"');
      expect(sh).toContain('--folder "$COPILOT_MIYO_SEARCH_FOLDER"');
      expect(cmd).toContain('if /I "%COPILOT_MIYO_SEARCH_SCOPE%"=="unrestricted"');
      expect(cmd).toContain('--folder "%COPILOT_MIYO_SEARCH_FOLDER%"');
    });

    it("https://github.com/Brevilabs/obsidian-copilot-private/issues/121 omits the folder boundary only for explicit Unrestricted mode on POSIX and Windows", () => {
      const sh = miyoScript(".sh");
      const cmd = miyoScript(".cmd");

      expect(sh).toContain('unrestricted)\n    OUT=$("$MIYO" search "$QUERY" -n 10 --json');
      expect(cmd).toContain(
        'if /I "%COPILOT_MIYO_SEARCH_SCOPE%"=="unrestricted" (\n  "%MIYO%" search %* -n 10 --json'
      );
    });

    it("https://github.com/Brevilabs/obsidian-copilot-private/issues/121 fails closed when Current vault scope is missing, invalid, or unsupported", () => {
      for (const script of [miyoScript(".sh"), miyoScript(".cmd")]) {
        expect(script).toMatch(/active vault identity is missing/i);
        expect(script).toMatch(/invalid Search scope/i);
        expect(script).toMatch(/Do not (retry or )?run an unrestricted search/i);
        expect(script).toMatch(/Make sure the Miyo app is open/i);
      }
    });

    it("resolves the binary absolute-path-first with a PATH fallback, per OS", () => {
      // POSIX (.sh): absolute install path tried before falling back to PATH.
      expect(miyoScript(".sh")).toContain("$HOME/.miyo/bin/miyo");
      expect(miyoScript(".sh")).toContain("command -v miyo");
      // Windows (.cmd): the %LOCALAPPDATA% install, then PATH.
      expect(miyoScript(".cmd")).toContain("%LOCALAPPDATA%\\Miyo\\bin\\miyo\\miyo.exe");
      expect(miyoScript(".cmd")).toContain("where miyo");
    });

    it("degrades clearly when Miyo is not installed (both scripts)", () => {
      expect(miyoScript(".sh")).toMatch(/not installed/i);
      expect(miyoScript(".sh")).toMatch(/may not be running/i);
      expect(miyoScript(".cmd")).toMatch(/not installed/i);
    });
  });

  describe("MIYO_PARSE_SKILL", () => {
    const miyoParseScript = (ext: ".sh" | ".cmd"): string => {
      const file = MIYO_PARSE_SKILL.files.find((candidate) => candidate.path.endsWith(ext));
      if (!file) throw new Error(`miyo-parse ships no ${ext} script`);
      return file.content;
    };

    it("is a gated skill distinct from the always-seeded set and from Miyo search", () => {
      expect(BUILTIN_SKILLS).not.toContain(MIYO_PARSE_SKILL);
      expect(MIYO_PARSE_SKILL.name).toBe("miyo-parse");
      expect(MIYO_PARSE_SKILL.enabledAgents).toEqual(["claude", "codex", "opencode"]);
      expect(MIYO_PARSE_SKILL.skillMd).toContain(
        `copilot-builtin-version: "${MIYO_PARSE_SKILL.version}"`
      );
    });

    it("ships one wrapper per OS that runs `miyo parse` on a single quoted path", () => {
      expect(MIYO_PARSE_SKILL.files.map((file) => file.path)).toEqual([
        "miyo-parse.sh",
        "miyo-parse.cmd",
      ]);
      expect(miyoParseScript(".sh")).toContain('"$MIYO" parse "$FILE"');
      expect(miyoParseScript(".cmd")).toContain('"%MIYO%" parse "%~1"');
    });

    it("resolves Miyo's install path before falling back to PATH on each OS", () => {
      expect(miyoParseScript(".sh")).toContain("$HOME/.miyo/bin/miyo");
      expect(miyoParseScript(".sh")).toContain("command -v miyo");
      expect(miyoParseScript(".cmd")).toContain("%LOCALAPPDATA%\\Miyo\\bin\\miyo\\miyo.exe");
      expect(miyoParseScript(".cmd")).toContain("where miyo");
    });

    it("tells the agent to fail closed rather than reach for a cloud parser", () => {
      expect(MIYO_PARSE_SKILL.skillMd).toMatch(/Never fall back/i);
      expect(MIYO_PARSE_SKILL.skillMd).toMatch(/cloud document parser/i);
    });

    it("names the recovery path when the CLI is absent, since a remote server can't parse", () => {
      // `miyo parse` runs locally and never reads MIYO_URL, so a remote-only
      // user has to install the CLI to use this skill.
      expect(MIYO_PARSE_SKILL.skillMd).toMatch(/remote\s+Miyo\s+server\s+does\s+not\s+help/i);
      expect(MIYO_PARSE_SKILL.skillMd).toMatch(/install Miyo on this machine/i);
    });
  });

  describe("study skills", () => {
    const studySkillMd = (name: string): string => {
      const skill = BUILTIN_SKILLS.find((s) => s.name === name);
      if (!skill) throw new Error(`no builtin skill named ${name}`);
      return skill.skillMd;
    };

    it("study-quiz works on the session's attachments and quizzes one question at a time", () => {
      const md = studySkillMd("study-quiz");
      // Attach-anything: material comes from the session, else vault search or ask.
      expect(md).toMatch(/attached in this session/i);
      expect(md).toMatch(/seeded vault search skill/i);
      // Quiz shape and difficulty spread.
      expect(md).toMatch(/6-10 items/i);
      expect(md).toMatch(/definitions → application → transfer/i);
      // Interactive protocol: ask, wait, grade — no answer-key dump.
      expect(md).toMatch(/ONE question at a time/i);
      expect(md).toMatch(/correct \/ partially correct \/ wrong/i);
      expect(md).toMatch(/Never dump the answer key/i);
      expect(md).toMatch(/never\s+invent facts/i);
    });

    it("study-quiz logs misses into the dated gaps note with a scorecard close", () => {
      const md = studySkillMd("study-quiz");
      expect(md).toMatch(/Study\/Gaps\.md/);
      expect(md).toMatch(/## <YYYY-MM-DD> — <topic>/);
      expect(md).toMatch(/dedupe by question text/i);
      expect(md).toMatch(/wrong answer/i);
      expect(md).toMatch(/Why it matters/i);
      expect(md).toMatch(/X\/Y correct, weakest topic/);
    });

    it("feynman-grade grades with quoted follow-ups and withholds the gold version by default", () => {
      const md = studySkillMd("feynman-grade");
      expect(md).toMatch(/quote the user's exact words/i);
      expect(md).toMatch(/"why\/how" follow-up/i);
      expect(md).toMatch(/seeded vault search skill/i);
      expect(md).toMatch(/1-3 existing vault notes/i);
      expect(md).toMatch(/ONLY if the\s+user asks/i);
      expect(md).toMatch(/Never dump the full correct explanation/i);
    });

    it("defense-sim runs committee rounds, refuses fabricated rivals, and shares the gaps-note format", () => {
      const md = studySkillMd("defense-sim");
      expect(md).toMatch(/Contribution & motivation/i);
      expect(md).toMatch(/Related work/i);
      expect(md).toMatch(/Method & analysis/i);
      expect(md).toMatch(/Validity & ethics/i);
      expect(md).toMatch(/plausible rivals\s+from the vault/i);
      expect(md).toMatch(/not in the\s+material/i);
      expect(md).toMatch(/Study\/Gaps\.md/);
      expect(md).toMatch(/study-quiz/);
    });

    it("paper-companion checks comprehension before critique and names the scanned-PDF fallback", () => {
      const md = studySkillMd("paper-companion");
      expect(md).toMatch(/3 short questions/i);
      expect(md).toMatch(/ONE at a time/i);
      expect(md).toMatch(/falsify/i);
      expect(md).toMatch(/skeptical reviewer/i);
      expect(md).toMatch(/critique skeleton/i);
      expect(md).toMatch(/read-scanned-pdf/);
    });

    it("youtube-notes posts through the tokened local channel and writes into Lectures/", () => {
      const md = studySkillMd("youtube-notes");
      expect(md).toContain("COPILOT_SELF_HOST_YOUTUBE_URL");
      expect(md).toContain("Authorization: Bearer $COPILOT_SELF_HOST_YOUTUBE_TOKEN");
      expect(md).toMatch(/Lectures\//);
      expect(md).toMatch(/<Title> \(<YYYY-MM-DD>\)\.md/);
      expect(md).toMatch(/Questions to self-check/i);
      expect(md).toMatch(/Supadata key/i);
      expect(md).toMatch(/study-quiz/);
    });

    it("read-files extracts office text locally with textutil and video keyframes with ffmpeg", () => {
      const md = studySkillMd("read-files");
      expect(md).toMatch(/textutil -convert txt -stdout/);
      expect(md).toMatch(/word\/document\.xml/);
      expect(md).toMatch(/<a:t>/);
      expect(md).toMatch(/ppt\/slides\/slide\*\.xml/);
      expect(md).toMatch(/brew install ffmpeg/);
      expect(md).toMatch(/-frames:v 12/);
      expect(md).toMatch(/LOCAL vision model/i);
      expect(md).toMatch(/fall back to a cloud service/i);
    });
  });

  describe("planManagedBuiltins()", () => {
    const names = (skills: readonly { name: string }[]): string[] => skills.map((s) => s.name);

    it("seeds only the always-on builtins when both Miyo gates are off", () => {
      const plan = planManagedBuiltins({ search: false, documents: false });
      // Stable reference, per the project's referential-stability rule.
      expect(plan.seed).toBe(BUILTIN_SKILLS);
      expect(plan.prune).toEqual([
        ...[
          "copilot-web-search",
          "copilot-web-fetch",
          "copilot-read-pdf",
          "copilot-youtube-transcript",
          "copilot-fetch-x",
          "openartifacts-publish",
        ],
        "miyo-search",
        "miyo-parse",
      ]);
    });

    it("gates search and document parsing independently", () => {
      expect(names(planManagedBuiltins({ search: true, documents: false }).seed)).toEqual([
        ...names(BUILTIN_SKILLS),
        "miyo-search",
      ]);
      expect(planManagedBuiltins({ search: true, documents: false }).prune).toEqual([
        "copilot-web-search",
        "copilot-web-fetch",
        "copilot-read-pdf",
        "copilot-youtube-transcript",
        "copilot-fetch-x",
        "openartifacts-publish",
        "miyo-parse",
      ]);
      expect(planManagedBuiltins({ search: false, documents: true }).seed).toContain(
        MIYO_PARSE_SKILL
      );
      expect(planManagedBuiltins({ search: false, documents: true }).prune).toEqual([
        "copilot-web-search",
        "copilot-web-fetch",
        "copilot-read-pdf",
        "copilot-youtube-transcript",
        "copilot-fetch-x",
        "openartifacts-publish",
        "miyo-search",
      ]);
    });

    it("seeds both gated skills without touching the always-on set", () => {
      const plan = planManagedBuiltins({ search: true, documents: true });
      expect(names(plan.seed)).toEqual([...names(BUILTIN_SKILLS), "miyo-search", "miyo-parse"]);
      // Retired relay folders are pruned on every pass, even when both Miyo
      // gates are on and the gated-prune list would otherwise be empty.
      expect(plan.prune).toEqual([
        "copilot-web-search",
        "copilot-web-fetch",
        "copilot-read-pdf",
        "copilot-youtube-transcript",
        "copilot-fetch-x",
        "openartifacts-publish",
      ]);
    });
  });
});
