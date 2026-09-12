import type { BuiltinSkill } from "./builtinSkills";

/**
 * Knowledge-only workflow skills: the local OCR fallback for scanned PDFs, the
 * structured Research Mode workflow, and the Study suite (quiz, Feynman
 * grading, committee simulation, paper study). None ships scripts — they steer
 * the agent toward local tooling the backend already has (shell + vision) and
 * the seeded vault/web skills, so no relay access or extra runtime is required.
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

const STUDY_QUIZ_VERSION = 1;

export const STUDY_QUIZ_SKILL: BuiltinSkill = {
  name: "study-quiz",
  version: STUDY_QUIZ_VERSION,
  enabledAgents: ENABLED_AGENTS,
  skillMd: `---
name: study-quiz
description: Quiz the user on the material attached in this session — notes, PDFs, excerpts — one question at a time, then log every miss into a gaps note. Use for "quiz me on this", "test me", or any request to be quizzed on their material.
metadata:
  copilot-enabled-agents: claude, codex, opencode
  copilot-builtin-version: "${STUDY_QUIZ_VERSION}"
---

# Quiz me on this

Attach anything, quiz that. Work only from this session's material — never
invent facts it does not contain.

## Material

Study whatever the user attached in this session: notes, PDFs, excerpts. If
nothing is attached, first use the seeded vault search skill (miyo-search, else
grep) to locate the material; if that fails, ask the user to attach or name it.

## Quiz shape

Plan 6-10 items before starting, then run them one at a time:

- 3-4 multiple choice (exactly one correct option).
- 3-4 short answer.
- 2-3 "explain why" questions.
- Difficulty spread: definitions → application → transfer (apply the ideas to
  a context the material does not state verbatim).

Ground every question in the attached material. Never invent facts not present
in it.

## Interactive protocol

- Ask ONE question at a time in chat, then wait for the answer.
- Grade each answer: correct / partially correct / wrong. Give the correct
  answer plus a one-paragraph explanation, then move on to the next question.
- Never dump the answer key or the list of questions up front.

## Gaps note

After the quiz, or when the user says stop, append a section to the gaps note.
Default \`Study/Gaps.md\` — create the folder and file if missing; if the user
names another file, use that one.

If the note exists, append under a \`## <YYYY-MM-DD> — <topic>\` heading without
duplicating prior items (dedupe by question text). Record per missed or
partially correct item:

~~~markdown
## <YYYY-MM-DD> — <topic>
- **Question:** <the question>
- **Your answer:** <the user's wrong answer>
- **Correct answer:** <the correct answer>
- **Why it matters:** <one line>
~~~

## Close

End with a one-line scorecard (X/Y correct, weakest topic) and suggest ONE
follow-up action: retry the missed items, or study the linked notes.
`,
  files: [],
};

const FEYNMAN_GRADE_VERSION = 1;

export const FEYNMAN_GRADE_SKILL: BuiltinSkill = {
  name: "feynman-grade",
  version: FEYNMAN_GRADE_VERSION,
  enabledAgents: ENABLED_AGENTS,
  skillMd: `---
name: feynman-grade
description: Grade the user's own explanation of a concept like a strict but fair teacher — name what is solid, quote each gap and ask one why/how follow-up, and link related vault notes. Use for "grade my explanation" or Feynman-technique practice.
metadata:
  copilot-enabled-agents: claude, codex, opencode
  copilot-builtin-version: "${FEYNMAN_GRADE_VERSION}"
---

# Grade my explanation

The user explains a concept in their own words; grade it like a strict but fair
teacher. The goal is their recall, not your lecture.

## Workflow

1. **Solid.** Name what the explanation gets right, briefly.
2. **Gaps.** For each vague or wrong part, quote the user's exact words and ask
   ONE "why/how" follow-up question that makes them confront the gap.
3. **Links.** Use the seeded vault search skill (miyo-search, else grep) to
   link 1-3 existing vault notes per gap that the user can study from.
4. **Gold.** Give a rewritten "gold" version of the explanation ONLY if the
   user asks for it. Default: do not give the answer away.

Never dump the full correct explanation unless the user explicitly asks for the
answer after attempting it themselves.
`,
  files: [],
};

const DEFENSE_SIM_VERSION = 1;

export const DEFENSE_SIM_SKILL: BuiltinSkill = {
  name: "defense-sim",
  version: DEFENSE_SIM_VERSION,
  enabledAgents: ENABLED_AGENTS,
  skillMd: `---
name: defense-sim
description: Run a graduate-committee simulation over the user's attached research, proposal, or research-plan notes — rounds on contribution, related work, method, and validity/ethics, ending in a scorecard and a gaps-note log. Use for mock defense, defense rehearsal, or "simulate my committee".
metadata:
  copilot-enabled-agents: claude, codex, opencode
  copilot-builtin-version: "${DEFENSE_SIM_VERSION}"
---

# Committee simulation

Act as the user's graduate committee. Read the attached research, proposal, or
research-plan notes FIRST, before asking anything.

## Rounds

1. **Contribution & motivation.** What's new, why does it matter, who cares.
2. **Related work.** "How is this different from X?" — pick plausible rivals
   from the vault.
3. **Method & analysis.** How it works, why this design, what would falsify it.
4. **Validity & ethics.** Threats to validity, limitations, ethics.

## Protocol

- One question per turn, hard but fair.
- After each answer: evaluate it briefly, then drill one level deeper on the
  weakest part of that answer.
- After 3 rounds, or when the user says stop, give a scorecard: strongest and
  weakest sections, then append the concrete gaps to the gaps note in the same
  format the \`study-quiz\` skill uses (default \`Study/Gaps.md\`, dated
  \`## <YYYY-MM-DD> — <topic>\` headings, dedupe by question text).

## Grounding

Never fabricate vault content. A rival claim must come from the attached
material or from a vault search; when it is not there, say "not in the
material" and move on.
`,
  files: [],
};

const PAPER_COMPANION_VERSION = 1;

export const PAPER_COMPANION_SKILL: BuiltinSkill = {
  name: "paper-companion",
  version: PAPER_COMPANION_VERSION,
  enabledAgents: ENABLED_AGENTS,
  skillMd: `---
name: paper-companion
description: Guided study of an attached paper (PDF or excerpt) — comprehension checks first, then method-focused critique, ending with a critique skeleton the user can paste into their notes. Use for "study this paper", paper reading, or paper critique requests.
metadata:
  copilot-enabled-agents: claude, codex, opencode
  copilot-builtin-version: "${PAPER_COMPANION_VERSION}"
---

# Study this paper

Work on the paper attached in this session — a PDF or an excerpt. If the PDF
has no text layer, mention the \`read-scanned-pdf\` skill as the fallback.

## Phase 1 — comprehension

1. Read the paper end to end before asking anything.
2. Ask the user 3 short questions, ONE at a time, to check understanding. Wait
   for each answer; give nothing away before they attempt it.
3. Correct misunderstandings after each attempt, not before.

## Phase 2 — critique

Ask method-focused questions, one at a time:

- Is the design justified by the research question?
- Are the measures valid for the claim?
- What result would falsify the claim?
- What would a skeptical reviewer push on?

## Deliverable

End with a structured critique skeleton the user can paste into their note —
claim, method, evidence, limitations, open questions — citing pages where
possible (e.g. \`[p. 4]\`). Quote the paper; never invent results it does not
report.
`,
  files: [],
};
