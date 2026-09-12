/**
 * The Copilot Agent Mode system prompt, shared by every backend.
 *
 * Why this exists: each agent backend defaults to a generic "CLI software
 * engineering tool" framing that is wrong for an Obsidian vault assistant —
 * opencode's `default.txt`, codex-acp's built-in prompt, and the Claude Agent
 * SDK's `claude_code` preset. Forwarding `COPILOT_PROMPT_BASE` to all three
 * gives the same "you are an Obsidian vault assistant" framing everywhere.
 *
 * `buildAgentSystemPrompt` composes the built-in payload each backend forwards:
 *
 *   1. `COPILOT_PROMPT_BASE` (the Obsidian-vault identity) — unless the user
 *      enabled Settings → System prompts → "Disable builtin system prompt".
 *      Then document steering selected by `docProcessorBackend` (the local
 *      fail-closed block only when the user picked Miyo), followed by
 *      `COPILOT_MIYO_SEARCH_STEERING` — appended only when the dedicated
 *      Miyo search-skill setting is enabled. Task-planning guidance follows as
 *      another internal behavior layer.
 *   2. `COPILOT_PROJECT_WORKSPACE_POLICY`, `COPILOT_INSTRUCTION_PRECEDENCE`, and
 *      the pill-syntax directive (`buildPillSyntaxDirective`) — always present;
 *      they teach the agent where a project session may write, which AGENTS.md
 *      wins on conflict, and how to read the chat editor's `[[note]]`/`{folder}`
 *      tokens, which is functional wiring rather than "builtin framing" the user
 *      toggles.
 *
 * User-authored Agent Mode instructions live in AGENTS.md and are discovered
 * from the session working directory instead of being copied into this prompt.
 * The output is therefore byte-identical across vaults, projects, paths, dates,
 * models, and sessions — only product source edits and the capability toggles
 * above may change it. That invariant is what makes the prompt a stable cache
 * prefix; see `agentSystemPrompt.test.ts` for the assertions that hold it.
 *
 * `COPILOT_PROMPT_BASE` content is curated, not invented. Two existing Copilot
 * prompts cover most of what's needed:
 *
 *   - `DEFAULT_SYSTEM_PROMPT` (`src/constants.ts`) — the chat-mode identity and
 *     formatting rules. Most rules port directly; chat-only hooks (`@vault`,
 *     `getCurrentTime`, YouTube auto-transcribe) are dropped because that
 *     infrastructure does not exist in Agent Mode. Reusing `DEFAULT_SYSTEM_PROMPT`
 *     verbatim would re-introduce that noise.
 *   - `AGENT_LOOP_GUIDANCE` (`src/LLMProviders/chainRunner/
 *     AutonomousAgentChainRunner.ts`) — the in-process autonomous agent's loop
 *     bullets. Ported verbatim — the agent shape is the same.
 */
// Import the pill directive from its module rather than the skills barrel: a
// system-prompt builder needs only this one pure function, not SkillManager,
// discovery, or the Skills UI the barrel also re-exports.
import { buildPillSyntaxDirective } from "@/agentMode/skills/pillSyntaxDirective";
import { getSettings } from "@/settings/model";
import { AGENT_TODO_PLANNING_STEERING } from "@/system-prompts/agentTodoPlanningSteering";
import { getDisableBuiltinSystemPrompt } from "@/system-prompts/state";
/**
 * Document steering when Miyo is the selected Document Processor. Sent only in
 * that mode — the agent gets no document section at all otherwise, so it can
 * never be pointed at a skill that is not seeded. It fails closed on purpose:
 * an agent left free to pick its own fallback must not silently upload a
 * document the user chose to keep local.
 */
export const COPILOT_MIYO_DOCUMENT_STEERING = `## Document processing (local, Miyo)
The user selected Miyo as their Document Processor, so PDFs and EPUBs must stay on their machine. For any PDF or EPUB file, use the \`miyo-parse\` skill, which parses it locally.

If \`miyo-parse\` is missing or fails, report the problem and stop — never send the document to a cloud parser or any other web service.`;

/**
 * Steers the agent toward the bundled `miyo-search` skill for vault search. A
 * prose skill is only invoked if the model thinks to use it, and the SKILL.md
 * description alone proved unreliable, so we name it explicitly in the system
 * prompt, with concrete triggers (grep too slow / too few relevant hits /
 * explicit request).
 *
 * Unlike the always-sent sections, this is gated by `enableMiyoSearchSkill`, so
 * it never tells the agent to reach for a skill that isn't seeded. That keeps
 * the prompt in lockstep with the seeding gate in `agentMode/index.ts`.
 */
export const COPILOT_MIYO_SEARCH_STEERING = `## Vault semantic search (Miyo)
The user has Miyo enabled: local, meaning-based semantic search over their vault. For any vault-search intent, use the \`miyo-search\` skill when your builtin \`grep\` search is too slow or doesn't surface enough relevant notes, or whenever the user explicitly asks for Miyo search. Follow the skill's own instructions to run it.`;

/**
 * Where a project session may read and write. Program-authored policy, not "builtin framing":
 * it is operational wiring (file placement + the opted-in read surface), so — like the
 * pill-syntax directive — it survives the user's "Disable builtin system prompt" toggle. That
 * also preserves the pre-AGENTS.md behavior, where this policy rode the generated project
 * mirror and Claude's `<project_instructions>` append, neither of which the toggle touched.
 *
 * Gated on the `<project_context>` block rather than a scope flag so the same prompt text is
 * correct for a global session (no block → the section is inert), keeping one payload per
 * backend instead of one per scope.
 */
export const COPILOT_PROJECT_WORKSPACE_POLICY = `## Project workspaces
When the conversation includes a \`<project_context>\` block:
- Treat the working directory as that project's workspace. Write generated files, drafts, and intermediate artifacts under an \`outputs/\` folder inside it, creating it if needed, unless the user names a different destination.
- Read and search inside the working directory by default. The configured context sources in \`<project_context>\` are also opted in even when they live outside it. When a source shows a \`→ <absolute path>\` snapshot pointer, read that path directly.
- Don't reach for unrelated files outside the working directory or configured context sources unless the instructions or user name a specific file or location.`;

/**
 * Resolves conflicts between the two AGENTS.md scopes. Each harness loads instruction files
 * with its own rules — opencode 1.18.16 collects every ancestor AGENTS.md nearest-first, so
 * the project file arrives *before* the vault one — and none of those orders is configurable
 * through a documented seam. Stating the rule in prompt text is therefore the only place the
 * precedence holds for every backend at once, and it costs the same bytes in all of them.
 *
 * Always sent, like the workspace policy above: it describes how to read the user's own
 * instructions, not Copilot framing the user opted out of.
 */
export const COPILOT_INSTRUCTION_PRECEDENCE = `## AGENTS.md precedence
The user's own instructions reach you as AGENTS.md files, in whatever order this runtime loads them. Judge them by scope, not by the order they appear in: an AGENTS.md inside the current project folder is more specific than the one at the vault root, so follow the project file wherever the two conflict.`;

export const COPILOT_PROMPT_BASE = `You are Obsidian Copilot, an AI assistant that helps users work with their Obsidian vault — markdown notes for knowledge management, writing, and research. You are NOT a software-engineering agent or CLI coding tool. The working directory is the user's Obsidian vault, or a project folder within it: a collection of markdown notes, not a code repository. Disregard any framing in environment metadata that suggests otherwise.

## Grounding
- The user's vault contains markdown notes. When the user says "note", they mean an Obsidian note in this vault.
- When the user mentions "tags", they usually mean tags in Obsidian note properties.
- Never claim you do not have access to something. Rely on the user's provided context and the tools available to you.
- If you are unsure, say so and ask for more context — don't guess.
- Always respond in the language of the user's query.

## Tool Behavior
- Prefer evidence from \`read\`, \`grep\`, and \`glob\` over assumption. Don't infer what a note contains from its title — read it.
- NEVER search for the same or very similar query twice. If results were insufficient, try substantially different terms.
- After 1-2 searches, synthesize an answer from the results you have. Do not keep searching unless the results are clearly insufficient.
- If you have enough information to answer, respond directly without calling any more tools.

## Response Style
- Respond at length appropriate to note-taking and knowledge work. Do NOT default to 1-3 line CLI cadence — give the user enough context to understand and act on your answer.
- Be direct and concrete. Don't pad with preamble or postamble.

## Markdown Formatting
- Use \`$...$\` for LaTeX equations, never \`\\[...\\]\` or \`\\(...\\)\`.
- When showing note titles, use the \`[[title]]\` wikilink format and never wrap them in backticks or quotes.
- For Obsidian-internal image links, use the \`![[link]]\` format and never wrap them in backticks.
- For web image links, use the \`![alt](url)\` format and never wrap them in backticks.
- For tables, use valid GitHub-flavored markdown: a header row, then a delimiter row of dashes (e.g. \`| --- | --- |\`), then one row per record — every row wrapped in leading and trailing \`|\`. Put a blank line before the table. If you label the table, put the label on its own line above that blank line; never append a trailing \`|\` to a caption, heading, or any line that is not itself a table row.`;

/**
 * Compose the full system prompt every Agent Mode backend forwards. See the
 * file header for the three parts and their ordering rationale.
 *
 * The prompt is provider-agnostic by design: `COPILOT_PROMPT_BASE` establishes
 * the Obsidian-vault identity and markdown rules, neither of which varies by
 * model family. It is deliberately NOT keyed on the live model — opencode hosts
 * BYOK models from many providers in one session and switches between them via
 * `setSessionModel` without respawning, so any spawn-time model snapshot would
 * be stale the moment the user switched families. If per-family prompt tuning
 * is ever needed, key it off the live model at a respawn or per-turn boundary
 * (e.g. a `restartOnModelChange` descriptor flag) — not a spawn-time id.
 *
 * Reads the live built-in-prompt state (`getDisableBuiltinSystemPrompt`) at call time.
 * Backends call this at their natural
 * prompt-injection point — spawn time for opencode/codex, `newSession()` for
 * the Claude SDK — so a settings change applies to the next session.
 *
 * Project *file context* (folders/notes/URLs) is NOT part of the system prompt:
 * it is delivered as a `<project_context>` block inlined into the session's
 * first user message (reachable by all three backends), built by the context
 * materializer's `buildProjectContextBlock`.
 */
export function buildAgentSystemPrompt(): string {
  const parts: string[] = [];

  // The "Disable builtin system prompt" toggle suppresses only the Copilot
  // base framing — mirroring how legacy chat's `getSystemPrompt()` drops
  // `DEFAULT_SYSTEM_PROMPT`. The pill-syntax directive below is functional
  // wiring (it explains the editor's mention tokens), not builtin framing, so
  // it is always sent.
  if (!getDisableBuiltinSystemPrompt()) {
    const settings = getSettings();
    parts.push(COPILOT_PROMPT_BASE);
    // Document steering is sent only when the user selected Miyo: naming any
    // document route in the default payload would point the agent at a skill
    // that is not seeded (the local route exists only in the Miyo case).
    if (settings.docProcessorBackend === "miyo") {
      parts.push(COPILOT_MIYO_DOCUMENT_STEERING);
    }
    // Miyo steering is gated on the same flag that seeds the skill, so we only
    // point the agent at `miyo-search` when the user has installed it — the
    // prompt-side half of respecting the "Miyo search skill" toggle.
    if (settings.enableMiyoSearchSkill === true) {
      parts.push(COPILOT_MIYO_SEARCH_STEERING);
    }
    parts.push(AGENT_TODO_PLANNING_STEERING);
  }

  // Outside the toggle on purpose — see COPILOT_PROJECT_WORKSPACE_POLICY.
  parts.push(COPILOT_PROJECT_WORKSPACE_POLICY);
  parts.push(COPILOT_INSTRUCTION_PRECEDENCE);
  parts.push(buildPillSyntaxDirective());

  return parts.join("\n\n");
}
