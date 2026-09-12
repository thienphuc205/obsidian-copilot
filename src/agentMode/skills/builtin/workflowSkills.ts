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

const YOUTUBE_NOTES_VERSION = 1;

export const YOUTUBE_NOTES_SKILL: BuiltinSkill = {
  name: "youtube-notes",
  version: YOUTUBE_NOTES_VERSION,
  enabledAgents: ENABLED_AGENTS,
  skillMd: String.raw`---
name: youtube-notes
description: Turn a shared YouTube lecture into a structured vault note — TL;DR, grouped key points with rough timestamps, definitions, self-check questions, and the source link. Use when the user shares a YouTube URL and wants it studied or turned into notes.
metadata:
  copilot-enabled-agents: claude, codex, opencode
  copilot-builtin-version: "${YOUTUBE_NOTES_VERSION}"
---

# Turn a lecture into a note

The user shares a YouTube URL (a lecture, talk, or tutorial) and wants it
studied and captured as a note in their vault.

## 1. Fetch the transcript

Request it through the plugin's local channel with curl. The URL and token come
from your environment; do not hardcode or guess them.

~~~bash
curl -sS -X POST "$COPILOT_SELF_HOST_YOUTUBE_URL" \
  -H "Authorization: Bearer $COPILOT_SELF_HOST_YOUTUBE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url": "<the YouTube URL the user shared>"}'
~~~

On success the response JSON is \`{"response": {"transcript": "..."},
"elapsed_time_ms": ...}\` — read \`response.transcript\`. The transcript passes
only to the model the user already configured in Copilot; it is not sent
anywhere else.

## 2. Write the note

Default folder \`Lectures/\` (create it if missing); ask before choosing a
different location. Filename \`<Title> (<YYYY-MM-DD>).md\`, title from the
lecture itself, not the URL slug. Structure:

- One-line TL;DR at the top.
- **Key points** — grouped by theme, with rough timestamps where the transcript
  gives them (e.g. \`[12:30]\`).
- **Definitions & terms** — each term with the lecture's own wording.
- **Questions to self-check** — 3-5 questions, no answers.
- **Sources** — the YouTube URL.

Ground every point in the transcript; never invent content it does not contain.

## 3. If it fails, stop and tell the user exactly what to configure

Do not retry in a loop.

- The env vars are missing → tell the user to enable Self-Host Mode in Copilot
  settings (it provides the local transcript channel) and restart the session.
- The response says the Supadata API key is missing → tell the user to add
  their Supadata key in Copilot settings (Self-Host section), then retry once.
- The response says the transcript is processing or returns an async job →
  report that to the user and stop; do not poll.
- Any other error → report the error message verbatim and stop.

## Follow-up

After writing the note, offer one follow-up: "want a quiz on this lecture?
(study-quiz)".
`,
  files: [],
};

const READ_FILES_VERSION = 1;

export const READ_FILES_SKILL: BuiltinSkill = {
  name: "read-files",
  version: READ_FILES_VERSION,
  enabledAgents: ENABLED_AGENTS,
  skillMd: String.raw`---
name: read-files
description: Extract text locally from office files (.docx, .ppt, .pptx) and read keyframes from local video files (mp4/mov/mkv/webm) before answering, so attached material is never skipped. Use whenever the session includes such a file.
metadata:
  copilot-enabled-agents: claude, codex, opencode
  copilot-builtin-version: "${READ_FILES_VERSION}"
---

# Read office docs and video locally

Extract text from non-Markdown office files LOCALLY (no cloud converters, no
uploading the file anywhere) before reading them, so quiz/tutor/summary flows
can treat the extracted text as normal attached material.

## .docx

macOS:

~~~bash
textutil -convert txt -stdout "<file.docx>"
~~~

Otherwise, unzip and pull the document body (strip XML tags):

~~~bash
unzip -p "<file.docx>" word/document.xml | sed -e 's/<[^>]*>/ /g' | tr -s ' '
~~~

## .ppt / .pptx

Unzip to a temp dir first:

~~~bash
mkdir -p /tmp/copilot-slides && unzip -o "<file>" -d /tmp/copilot-slides
~~~

- \`.pptx\`: extract text runs from \`ppt/slides/slide*.xml\` — the \`<a:t>\`
  elements, in slide order — and emit one "## Slide N" heading per slide, e.g.
  \`sed -e 's/<[^>]*>/ /g' ppt/slides/slide1.xml\` per slide in numeric order.
  Slide images exist per slide (slideN.xml references them in
  ppt/media/); mention you can read those images with vision if the slide text
  alone looks incomplete.
- Legacy \`.ppt\`: try \`textutil -convert txt -stdout "<file.ppt>"\` (macOS). If
  that fails, tell the user no local converter is available for this file and
  stop; do not fall back to a cloud service.

## Local video files (mp4/mov/mkv/webm)

If \`ffmpeg\` is available, extract a bounded set of keyframes and read them as
IMAGES with your vision:

~~~bash
ffmpeg -i "<file>" -vf "fps=1/10" -frames:v 12 -q:v 2 /tmp/copilot-video/frame_%02d.jpg
~~~

- Cap at 12 frames (\`-frames:v 12\`); tune the interval (\`fps=1/<seconds>\`) to
  spread them over the video.
- For long videos, ask the user for the segment (start/duration) BEFORE
  extracting, and extract only that segment.
- No ffmpeg → give the one-line install (\`brew install ffmpeg\`) and stop; never
  install packages yourself.

### Token-saving suggestion (say it, don't block on it)

Reading many frames as images burns tokens on hosted models. When available,
suggest the user route frame reading through a LOCAL vision model — the OpenCode
BYOK provider for LM Studio/Ollama, or their configured local chat model — as a
suggestion, not a blocker.

## After extraction

Treat the extracted text/frames as normal attached material for this session —
quiz, tutor, summary, and grading flows proceed on it as usual.
`,
  files: [],
};
