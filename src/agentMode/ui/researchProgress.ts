/**
 * Pure derivation of the research-synthesis progress panel shown in Agent
 * Chat. No React and no Obsidian here — everything tolerates loose session
 * payloads so the card can adapt to whatever the trail carries.
 */

export interface ResearchToolEvent {
  toolName?: string;
  input?: unknown;
  output?: string;
}

export type ResearchStepId = "plan" | "vault" | "web" | "write";
export type ResearchStepStatus = "pending" | "active" | "done";

export interface ResearchProgressStep {
  id: ResearchStepId;
  status: ResearchStepStatus;
  /** Number of matching gather events; only meaningful for `vault` / `web`. */
  count?: number;
}

export interface ResearchProgress {
  steps: ResearchProgressStep[];
  /** Vault-relative path of the research note the run wrote, when known. */
  targetNotePath?: string;
}

/** The literal prefix the Telescope quick action seeds into the composer. */
const SEEDED_RESEARCH_PREFIX = /use the research skill for:/i;
/** Standalone marker kept deliberately narrow: the user names the research skill. */
const RESEARCH_SKILL_PHRASE = /research skill/i;

/**
 * Whether a turn should render the research progress panel instead of the
 * raw tool-call trail. Conservative by design: only the seeded quick-action
 * prefix or an explicit "research skill" mention counts, so ordinary turns
 * that merely touch research notes keep their normal trail.
 */
export function isResearchRun(userMessage: string | undefined): boolean {
  if (!userMessage) return false;
  return SEEDED_RESEARCH_PREFIX.test(userMessage) || RESEARCH_SKILL_PHRASE.test(userMessage);
}

const VAULT_TOOL_NAMES = new Set(["localsearch", "lexicalsearch", "grep", "glob"]);
const VAULT_COMMAND_MARKERS = ["miyo-search.sh"];
const GREP_COMMAND = /\b(?:grep|rg)\b/i;
const EXECUTE_TOOL_NAMES = new Set(["bash", "execute", "shell"]);
const WEB_TOOL_NAMES = new Set(["websearch", "webfetch"]);
const WEB_COMMAND_MARKERS = ["copilot-web-search", "copilot-web-fetch"];

/**
 * The path shape the research workflow writes to (`Research/<name>.md`).
 * Vault note names contain spaces (the quick action scaffolds
 * `Research/<topic>.md`), so the name class allows them; quotes and angle
 * brackets still end the match so surrounding JSON/markup is not swallowed,
 * and the non-greedy `\.md` keeps the first note boundary per match.
 */
const RESEARCH_NOTE_PATH = /Research\/[^"<>]+?\.md/;

function searchableText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function isVaultEvent(event: ResearchToolEvent, inputText: string): boolean {
  const tool = event.toolName?.toLowerCase();
  if (tool && VAULT_TOOL_NAMES.has(tool)) return true;
  if (VAULT_COMMAND_MARKERS.some((marker) => inputText.includes(marker))) return true;
  return !!tool && EXECUTE_TOOL_NAMES.has(tool) && GREP_COMMAND.test(inputText);
}

function isWebEvent(event: ResearchToolEvent, inputText: string): boolean {
  const tool = event.toolName?.toLowerCase();
  if (tool && WEB_TOOL_NAMES.has(tool)) return true;
  return WEB_COMMAND_MARKERS.some((marker) => inputText.includes(marker));
}

/**
 * Collapse the run's tool events into step statuses. The panel replaces the
 * raw trail, so every state is derived from what already happened rather
 * than from live in-flight hints:
 *
 *   - Plan stays `active` until the first gather event proves the agent
 *     moved on, then is `done`.
 *   - Vault / Web are `done` once at least one matching event exists, and
 *     `active` from run start until then.
 *   - Write is `done` once any event mentions a `Research/<name>.md` path
 *     (the last such path wins, so repeated writes to the same note collapse
 *     into one target), `active` once both gather steps finished, and
 *     `pending` before that.
 *
 * Returns null for an event-less run so the caller can keep the normal trail
 * until the first tool call lands.
 */
export function deriveResearchProgress(events: ResearchToolEvent[]): ResearchProgress | null {
  if (!Array.isArray(events) || events.length === 0) return null;

  let vaultCount = 0;
  let webCount = 0;
  let sawGather = false;
  let targetNotePath: string | undefined;

  for (const event of events) {
    const inputText = searchableText(event.input);
    if (isVaultEvent(event, inputText)) {
      vaultCount += 1;
      sawGather = true;
    } else if (isWebEvent(event, inputText)) {
      webCount += 1;
      sawGather = true;
    }
    const mention =
      extractResearchNotePath(inputText) ?? extractResearchNotePath(event.output ?? "");
    if (mention) targetNotePath = mention;
  }

  const vaultDone = vaultCount > 0;
  const webDone = webCount > 0;

  return {
    steps: [
      { id: "plan", status: sawGather ? "done" : "active" },
      { id: "vault", status: vaultDone ? "done" : "active", count: vaultCount },
      { id: "web", status: webDone ? "done" : "active", count: webCount },
      {
        id: "write",
        status: targetNotePath ? "done" : vaultDone && webDone ? "active" : "pending",
      },
    ],
    targetNotePath,
  };
}

function extractResearchNotePath(text: string): string | undefined {
  return RESEARCH_NOTE_PATH.exec(text)?.[0];
}

// Bounds keep untrusted session payloads from flooding the panel's derivation
// input; a truncated command can still carry its skill-script marker because
// those appear early in the command line.
const MAX_TOOL_NAME_CHARS = 64;
const MAX_INPUT_CHARS = 4000;
const MAX_OUTPUT_CHARS = 2000;

function clamp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeBoundedInput(input: unknown): string | undefined {
  if (typeof input === "string") {
    return input.length > 0 ? clamp(input, MAX_INPUT_CHARS) : undefined;
  }
  if (input === undefined || input === null) return undefined;
  try {
    return clamp(JSON.stringify(input), MAX_INPUT_CHARS);
  } catch {
    return undefined;
  }
}

function normalizeBoundedOutput(output: unknown): string | undefined {
  if (typeof output === "string") {
    return output.length > 0 ? clamp(output, MAX_OUTPUT_CHARS) : undefined;
  }
  // Tool-call parts carry `AgentToolCallOutput[]`; join the text chunks so a
  // written note path mentioned in a result stays extractable.
  if (Array.isArray(output)) {
    const text = output
      .map((chunk) => {
        if (typeof chunk === "string") return chunk;
        const text = (chunk as { text?: unknown } | null)?.text;
        return typeof text === "string" ? text : "";
      })
      .join("\n");
    return text.length > 0 ? clamp(text, MAX_OUTPUT_CHARS) : undefined;
  }
  if (output === undefined || output === null) return undefined;
  try {
    return clamp(JSON.stringify(output), MAX_OUTPUT_CHARS);
  } catch {
    return undefined;
  }
}

/**
 * Normalize an untrusted session payload (a raw tool_call part or a persisted
 * event) into the bounded shape `deriveResearchProgress` consumes. Tool name
 * resolution prefers the vendor identity, then the generic name, then the
 * display title — mirroring how the trail labels calls.
 */
export function toResearchToolEvent(raw: unknown): ResearchToolEvent {
  if (typeof raw !== "object" || raw === null) return {};
  const source = raw as {
    toolName?: unknown;
    vendorToolName?: unknown;
    title?: unknown;
    input?: unknown;
    output?: unknown;
  };
  const name = [source.vendorToolName, source.toolName, source.title].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0
  );
  return {
    toolName: name === undefined ? undefined : clamp(name, MAX_TOOL_NAME_CHARS),
    input: normalizeBoundedInput(source.input),
    output: normalizeBoundedOutput(source.output),
  };
}
