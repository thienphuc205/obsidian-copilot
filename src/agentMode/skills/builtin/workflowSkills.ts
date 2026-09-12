import type { BuiltinSkill } from "./builtinSkills";

/**
 * Knowledge-only workflow skills: the local OCR fallback for scanned PDFs and
 * the structured Research Mode workflow. Neither ships scripts — they steer the
 * agent toward local tooling the backend already has (shell + vision) and the
 * seeded web skills, so no relay access or extra runtime is required.
 */

const ENABLED_AGENTS = ["claude", "codex", "opencode"] as const;

const READ_SCANNED_PDF_VERSION = 1;

export const READ_SCANNED_PDF_SKILL: BuiltinSkill = {
  name: "read-scanned-pdf",
  version: READ_SCANNED_PDF_VERSION,
  enabledAgents: ENABLED_AGENTS,
  skillMd: `---
name: read-scanned-pdf
description: Extract text from scanned/image-only PDFs by rasterizing pages locally and reading them with your vision. Use when a PDF reports no text layer.
metadata:
  copilot-enabled-agents: claude, codex, opencode
  copilot-builtin-version: "${READ_SCANNED_PDF_VERSION}"
---

# Read a scanned PDF

Rasterize pages locally, then read the images with your vision.

## 1. Rasterize (ask before rendering hundreds)

~~~bash
pdftoppm -r 150 -png "<pdf>" /tmp/copilot-pdf-pages/page
~~~

Missing tool → give the install line and stop; never install packages yourself.
macOS \`sips\` renders one page only.

## 2. Read the page images with vision

Transcribe headings, paragraph order, tables, captions; mark each page
\`[Page N]\`. Illegible page → say so, never guess.

## 3. Deliver

Summarize first; full transcription only if asked.
`,
  files: [],
};

const RESEARCH_VERSION = 1;

export const RESEARCH_SKILL: BuiltinSkill = {
  name: "research",
  version: RESEARCH_VERSION,
  enabledAgents: ENABLED_AGENTS,
  skillMd: `---
name: research
description: Structured research workflow. Plans sub-queries, gathers vault and web evidence, cross-checks conflicts, writes a sourced research note. Use for research/compare requests.
metadata:
  copilot-enabled-agents: claude, codex, opencode
  copilot-builtin-version: "${RESEARCH_VERSION}"
---

# Research Mode

Produce a decision-ready note, not a chat answer. Every claim traceable to a
source the user can open.

## Workflow

1. **Scope.** Ambiguous → one clarifying question; else state it in one sentence.
2. **Plan.** 2-5 sub-queries; show the plan before searching.
3. **Vault first.** Seeded vault search skill (miyo-search, else grep).
4. **Web.** Seeded web-search for snippets; web-fetch the 2-4 best pages
   (primary sources first). Record each URL and date.
5. **Cross-check.** Compare conflicting claims and dates.
6. **Write.** Default \`Research/\`; \`<Topic> (<YYYY-MM-DD>).md\`: research tag +
   date frontmatter, one-line verdict, sections with inline links, "Conflicts
   and caveats", \`## Sources\`. Never fabricate URLs or figures.
7. Offer one brief follow-up. Stay inside the selected scope.
`,
  files: [],
};
