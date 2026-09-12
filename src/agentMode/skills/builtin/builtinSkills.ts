import type { BackendId } from "@/agentMode/session/types";
import { OBSIDIAN_SKILLS } from "./obsidianSkills";
import {
  DEFENSE_SIM_SKILL,
  FEYNMAN_GRADE_SKILL,
  PAPER_COMPANION_SKILL,
  READ_SCANNED_PDF_SKILL,
  RESEARCH_SKILL,
  STUDY_QUIZ_SKILL,
} from "./workflowSkills";

/**
 * Plugin-shipped ("builtin") Agent Mode skills. Unlike user-authored skills,
 * these are seeded into the canonical skills folder by the plugin (see
 * `seedBuiltinSkills`) and refreshed when `version` bumps. A builtin may be
 * executable (the Miyo skills) or knowledge-only (the Obsidian format and CLI
 * skills, the workflow skills).
 */
export interface BuiltinSkill {
  /** Folder name + SKILL.md `name`. */
  readonly name: string;
  /**
   * Folder name of the managed predecessor this skill replaces. Its
   * `copilot-enabled-agents` choice carries over and the old folder is removed
   * once this one is seeded.
   */
  readonly legacyName?: string;
  /**
   * Bump when `skillMd` or any support file changes so seeded copies refresh.
   * Stamped into `metadata.copilot-builtin-version` in the seeded SKILL.md.
   */
  readonly version: number;
  /** Agents the skill fans out to (→ `metadata.copilot-enabled-agents`). */
  readonly enabledAgents: readonly BackendId[];
  /** Full SKILL.md file contents (frontmatter + body). */
  readonly skillMd: string;
  /** Supporting scripts, references, or notices written alongside SKILL.md. */
  readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  /** Previously shipped files to remove on upgrade, leaving user-added files alone. */
  readonly retiredFiles?: readonly string[];
}

/** Plugin-owned scope inputs consumed by the managed Miyo search wrappers. */
export const MIYO_SEARCH_SCOPE_ENV = "COPILOT_MIYO_SEARCH_SCOPE";
export const MIYO_SEARCH_FOLDER_ENV = "COPILOT_MIYO_SEARCH_FOLDER";
/** Routes managed web skills through the plugin host instead of a hosted relay. */
export const SELF_HOST_WEB_SEARCH_ENV = "COPILOT_SELF_HOST_WEB_SEARCH";
/** Per-lifecycle loopback endpoint for the plugin-owned search channel. */
export const SELF_HOST_WEB_SEARCH_URL_ENV = "COPILOT_SELF_HOST_WEB_SEARCH_URL";
/** Random bearer token authenticating the owning Agent Chat process. */
export const SELF_HOST_WEB_SEARCH_TOKEN_ENV = "COPILOT_SELF_HOST_WEB_SEARCH_TOKEN";

/** All always-seeded plugin-shipped skills, in display order. */
export const BUILTIN_SKILLS: readonly BuiltinSkill[] = [
  RESEARCH_SKILL,
  READ_SCANNED_PDF_SKILL,
  STUDY_QUIZ_SKILL,
  FEYNMAN_GRADE_SKILL,
  DEFENSE_SIM_SKILL,
  PAPER_COMPANION_SKILL,
  ...OBSIDIAN_SKILLS,
];

const MIYO_SEARCH_VERSION = 4;
const MIYO_PARSE_VERSION = 1;

/** Shared by both Miyo wrappers; the host script must define `die` before it. */
const MIYO_POSIX_RESOLVER = `# Absolute install path first (Obsidian shells often miss Miyo's bin on PATH).
if [ -x "$HOME/.miyo/bin/miyo" ]; then
  MIYO="$HOME/.miyo/bin/miyo"
elif command -v miyo >/dev/null 2>&1; then
  MIYO=miyo
else
  die "Miyo CLI not found (no ~/.miyo/bin/miyo and 'miyo' not on PATH). The Miyo desktop app is not installed — tell the user to install Miyo, then retry. Do not retry in a loop." 3
fi`;

const MIYO_WINDOWS_RESOLVER = `set "MIYO=%LOCALAPPDATA%\\Miyo\\bin\\miyo\\miyo.exe"
if not exist "%MIYO%" (
  set "MIYO="
  where miyo >nul 2>&1 && set "MIYO=miyo"
)
if not defined MIYO (
  echo Miyo CLI not found. The Miyo desktop app is not installed - tell the user to install Miyo, then retry. Do not retry in a loop. 1>&2
  exit /b 3
)`;

/**
 * POSIX (macOS/Linux) wrapper for the Miyo CLI; Windows uses the `.cmd` below.
 * Resolves the `miyo` binary itself — leading with the absolute install path
 * (`~/.miyo/bin/miyo`) because Obsidian-launched shells often inherit a reduced
 * PATH that misses it — then runs one `miyo search … --json` and prints the
 * JSON. A single deterministic command (vs. a PATH-first/absolute-fallback
 * procedure the agent has to reason through) is what makes smaller models invoke
 * it reliably.
 */
const MIYO_SEARCH_SH = `#!/bin/sh
# Semantic vault search via the local Miyo CLI; prints Miyo's JSON to stdout.
# Resolves the miyo binary so the agent never has to deal with PATH.
die() {
  printf '%s\\n' "$1" >&2
  exit "\${2:-2}"
}

QUERY="$*"
[ -n "$QUERY" ] || die "Usage: sh miyo-search.sh <query>" 1

${MIYO_POSIX_RESOLVER}

# Default closed: only the explicit Unrestricted value may omit Miyo's exact
# pre-retrieval folder boundary.
# https://github.com/Brevilabs/obsidian-copilot-private/issues/121
case "\${${MIYO_SEARCH_SCOPE_ENV}:-current}" in
  unrestricted)
    OUT=$("$MIYO" search "$QUERY" -n 10 --json 2>&1) || die "Miyo search failed — the Miyo app may not be running. Tell the user to open Miyo, then continue without vault search if they can't. Details: $OUT" 1
    ;;
  current)
    [ -n "\${${MIYO_SEARCH_FOLDER_ENV}:-}" ] || die "Miyo search could not enforce Current vault scope because the active vault identity is missing. Do not retry or run an unrestricted search." 4
    OUT=$("$MIYO" search "$QUERY" -n 10 --folder "$${MIYO_SEARCH_FOLDER_ENV}" --json 2>&1)
    if [ $? -ne 0 ]; then
      case "$OUT" in
        *"Folder not registered"*)
          die "This vault is not registered as its own folder in Miyo (a parent folder may be registered instead). Tell the user: in the Miyo app remove the overlapping folder registration, then add THIS exact vault folder and let it finish indexing, then retry. Do not retry in a loop and do not run an unrestricted search. Details: $OUT" 4
          ;;
        *)
          die "Miyo search could not enforce Current vault scope. Make sure the Miyo app is open, then retry once. Do not retry in a loop and do not run an unrestricted search. Details: $OUT" 1
          ;;
      esac
    fi
    ;;
  *)
    die "Miyo search received an invalid Search scope. Do not retry or run an unrestricted search." 4
    ;;
esac
printf '%s\\n' "$OUT"
`;

/**
 * Windows wrapper for the Miyo CLI; macOS/Linux uses the `.sh` above. `cmd` is
 * always present and runnable from cmd or PowerShell (no Git Bash or Node
 * needed — a managed-opencode Windows session may lack both). Resolves the exe
 * under `%LOCALAPPDATA%` (where the Miyo installer copies it) first, then PATH.
 */
const MIYO_SEARCH_CMD = `@echo off
setlocal enableextensions
rem Semantic vault search via the local Miyo CLI; prints Miyo's JSON to stdout.
if "%~1"=="" (
  echo Usage: miyo-search.cmd "query" 1>&2
  exit /b 1
)
${MIYO_WINDOWS_RESOLVER}
rem Default closed: only the explicit Unrestricted value may omit Miyo's exact
rem pre-retrieval folder boundary.
rem https://github.com/Brevilabs/obsidian-copilot-private/issues/121
if /I "%${MIYO_SEARCH_SCOPE_ENV}%"=="unrestricted" (
  "%MIYO%" search %* -n 10 --json
  if errorlevel 1 exit /b 1
  exit /b 0
)
if not "%${MIYO_SEARCH_SCOPE_ENV}%"=="" if /I not "%${MIYO_SEARCH_SCOPE_ENV}%"=="current" (
  echo Miyo search received an invalid Search scope. Do not retry or run an unrestricted search. 1>&2
  exit /b 4
)
if not defined ${MIYO_SEARCH_FOLDER_ENV} (
  echo Miyo search could not enforce Current vault scope because the active vault identity is missing. Do not retry or run an unrestricted search. 1>&2
  exit /b 4
)
"%MIYO%" search %* -n 10 --folder "%${MIYO_SEARCH_FOLDER_ENV}%" --json
if errorlevel 1 (
  echo Miyo search could not enforce Current vault scope. Make sure the Miyo app is open, then retry once. If the failure says Folder not registered, tell the user to add THIS exact vault folder in the Miyo app and let indexing finish. Do not run an unrestricted search. 1>&2
  exit /b 1
)
`;

const MIYO_PARSE_SH = `#!/bin/sh
# Parse one local PDF or EPUB through the Miyo CLI and print Markdown/text.
die() {
  printf '%s\\n' "$1" >&2
  exit "\${2:-2}"
}

FILE="$1"
[ -n "$FILE" ] || die "Usage: sh miyo-parse.sh <file>" 1

${MIYO_POSIX_RESOLVER}

"$MIYO" parse "$FILE"
`;

const MIYO_PARSE_CMD = `@echo off
setlocal enableextensions
rem Parse one local PDF or EPUB through the Miyo CLI and print Markdown/text.
if "%~1"=="" (
  echo Usage: miyo-parse.cmd "file" 1>&2
  exit /b 1
)
${MIYO_WINDOWS_RESOLVER}
"%MIYO%" parse "%~1"
`;

/**
 * Vault semantic search via the local Miyo desktop app's `miyo` CLI.
 *
 * Ships a runnable wrapper per OS — `.sh` for macOS/Linux, `.cmd` for Windows —
 * rather than prose telling the agent to construct the command. Each resolves
 * the binary across the absolute install path and PATH, so the agent runs ONE
 * deterministic command (no Node, no shell/OS branching to reason through).
 * Smaller models were giving up after the old PATH-first prose attempt failed in
 * Obsidian's reduced-PATH shells.
 *
 * The host seeds this skill only when the dedicated Miyo search-skill setting
 * is enabled (see `seedManagedBuiltins` in `agentMode/index`) and prunes the
 * managed copy when the setting is turned off.
 */
export const MIYO_SEARCH_SKILL: BuiltinSkill = {
  name: "miyo-search",
  version: MIYO_SEARCH_VERSION,
  enabledAgents: ["claude", "codex", "opencode"],
  skillMd: `---
name: miyo-search
description: Semantic (meaning-based) search over the user's Obsidian vault via the local Miyo app. For any vault-search intent, use it when builtin grep search is too slow or doesn't surface enough relevant notes, or when the user explicitly asks for Miyo search. Needs the Miyo desktop app installed and running.
metadata:
  copilot-enabled-agents: claude, codex, opencode
  copilot-builtin-version: "${MIYO_SEARCH_VERSION}"
---

# Miyo vault search

Search the user's indexed Obsidian vault through Miyo, the user's own companion
app for semantic search over their notes. It finds relevant notes by meaning
(not just filename). Searches go only to the user's own Miyo service — the local
app by default, or the remote Miyo server they configured in settings — never a
third-party API, and no API key.

When to use it: for any vault-search intent, reach for Miyo when your builtin
\`grep\` search is too slow or doesn't surface enough relevant notes, or when
the user explicitly asks for Miyo search.

## How to run

Find the absolute path to this SKILL.md file on disk, then run the script next
to it that matches the operating system, passing the user's full question as the
query. No extra runtime is needed — \`sh\` (macOS/Linux) and \`cmd\` (Windows) are
always present.

On macOS or Linux:

\`\`\`bash
sh "/absolute/path/to/this/skill/directory/miyo-search.sh" "<the user's question>"
\`\`\`

On Windows, run the \`.cmd\` wrapper. In PowerShell you must prefix it with the
call operator \`&\` (PowerShell treats a quoted path on its own as a string and
won't run it); from cmd, run the quoted path without the \`&\`:

\`\`\`powershell
& "/absolute/path/to/this/skill/directory/miyo-search.cmd" "<the user's question>"
\`\`\`

The script locates the Miyo binary itself and prints JSON to stdout — you do
not need to know where Miyo is installed or which shell you are in. Run the
script as your single search step; do not fall back to other search tools
unless it reports that Miyo is unavailable. Read the JSON straight from stdout;
do not pipe it through other tools (no \`jq\`, no \`|\`).

Search scope comes from Copilot settings. **Current vault** applies Miyo's exact
folder boundary for the active vault, including from Project chats.
**Unrestricted** searches every folder registered with Miyo.

## Reading the results

The script prints \`{ "results": [ { "path": ..., "content": ... } ], "count": N }\`.
Cite the \`path\` of any note you use so the user can open it.

## If it reports a problem

The script exits with a clear message when Miyo can't be used:

- **Not installed** (CLI not found): the Miyo desktop app isn't installed on
  this machine. Tell the user to install and open Miyo, then try again. Do not
  retry in a loop.
- **Not running** (search failed / can't reach the service): the app is
  installed but not running. Tell the user to open Miyo, then continue without
  vault search if they can't.
`,
  files: [
    { path: "miyo-search.sh", content: MIYO_SEARCH_SH },
    { path: "miyo-search.cmd", content: MIYO_SEARCH_CMD },
  ],
};

/**
 * Parses local PDF and EPUB files through the standalone Miyo CLI.
 *
 * This skill is gated by the Document Processor setting. It keeps document
 * contents local and deliberately fails closed: the
 * instructions forbid silently switching to a cloud parser if Miyo fails.
 */
export const MIYO_PARSE_SKILL: BuiltinSkill = {
  name: "miyo-parse",
  version: MIYO_PARSE_VERSION,
  enabledAgents: ["claude", "codex", "opencode"],
  skillMd: `---
name: miyo-parse
description: Parse a local PDF or EPUB file into Markdown/text with the local Miyo CLI. Use this for document reading when Miyo is the selected Document Processor. The file can be anywhere on the filesystem and does not need to be indexed or copied into the vault.
metadata:
  copilot-enabled-agents: claude, codex, opencode
  copilot-builtin-version: "${MIYO_PARSE_VERSION}"
---

# Parse a document locally with Miyo

Use Miyo to extract Markdown/text from one PDF or EPUB. Parsing runs locally,
works for files anywhere on the filesystem, and does not require the Miyo
service to be running.

## How to run

Find the absolute path to this SKILL.md file, then run the adjacent wrapper
with exactly one quoted file path.

On macOS or Linux:

\`\`\`bash
sh "/absolute/path/to/this/skill/directory/miyo-parse.sh" "/absolute/path/to/document.pdf"
\`\`\`

On Windows PowerShell:

\`\`\`powershell
& "/absolute/path/to/this/skill/directory/miyo-parse.cmd" "C:\\absolute\\path\\to\\document.pdf"
\`\`\`

The wrapper prints the parsed Markdown/text to stdout. Use that output to
answer the user's question.

## If it reports a problem

Report the error clearly and stop parsing that document. Never fall back to a
cloud document parser or any other web service: selecting Miyo is an explicit
local-processing choice. Do not retry in a loop.

If it reports that the Miyo CLI is not installed, say that pointing Copilot at a
remote Miyo server does not help here, and that the user's only option is to
install Miyo on this machine.
`,
  files: [
    { path: "miyo-parse.sh", content: MIYO_PARSE_SH },
    { path: "miyo-parse.cmd", content: MIYO_PARSE_CMD },
  ],
};

/** Every builtin the host may seed, gated or not — the universe it reconciles. */
const ALL_MANAGED_SKILLS: readonly BuiltinSkill[] = [
  ...BUILTIN_SKILLS,
  MIYO_SEARCH_SKILL,
  MIYO_PARSE_SKILL,
];

/**
 * Splits the managed builtins into what to write and what to remove, so the host
 * can't seed a gate without pruning its opposite.
 *
 * @param gates `search` mirrors `enableMiyoSearchSkill`, `documents` mirrors
 *   `docProcessorBackend === "miyo"`.
 */
export function planManagedBuiltins(gates: { search: boolean; documents: boolean }): {
  seed: readonly BuiltinSkill[];
  prune: readonly string[];
} {
  const seed: readonly BuiltinSkill[] =
    !gates.search && !gates.documents
      ? BUILTIN_SKILLS
      : [
          ...BUILTIN_SKILLS,
          ...(gates.search ? [MIYO_SEARCH_SKILL] : []),
          ...(gates.documents ? [MIYO_PARSE_SKILL] : []),
        ];
  return {
    seed,
    prune: ALL_MANAGED_SKILLS.filter((skill) => !seed.includes(skill)).map((skill) => skill.name),
  };
}
