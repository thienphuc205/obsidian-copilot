import { getSettings } from "@/settings/model";
import { startAgentWebBridge } from "@/web/acpWebBridge";
import { createWebProvider } from "@/web/provider";
import type { WebProvider, WebProviderId } from "@/web/types";
import { detectBinary } from "@/utils/detectBinary";
import type { AcpBackend, AcpMcpHttpServer, AcpSpawnDescriptor } from "@/agentMode/acp/types";
import { buildSimpleSpawnDescriptor } from "@/agentMode/backends/shared/simpleBinaryBackend";
import { buildAgentSystemPrompt } from "@/agentMode/backends/shared/agentSystemPrompt";
import {
  buildBuiltinSkillEnv,
  sanitizeBuiltinSkillEnvOverrides,
} from "@/agentMode/backends/shared/builtinSkillEnv";
import type { PlanUsageReading } from "@/agentMode/session/planUsage";
import { agentScopeWorkspaceRoot, getActiveAgentScope } from "@/agentMode/session/agentScope";
import { defaultCodexHome, readCodexPlanUsage } from "./codexPlanUsage";
import { mergeCodexConfigEnv } from "./codexConfigEnv";
import { buildCodexAcpInvocation, resolveSupportedCodexAcpEntry } from "./codexVersion";

interface AgentWebConfiguration {
  provider: WebProviderId;
  apiKey: string;
  baseUrl?: string;
}

function getAgentWebConfiguration(): AgentWebConfiguration | undefined {
  const settings = getSettings();
  if (settings.enableAgentWebTools !== true) return undefined;
  const provider = settings.agentWebSearchProvider;
  let apiKey: string;
  switch (provider) {
    case "firecrawl":
      apiKey = settings.firecrawlAgentWebApiKey;
      break;
    case "tavily":
      apiKey = settings.tavilyAgentWebApiKey;
      break;
    case "exa":
      apiKey = settings.exaAgentWebApiKey;
      break;
    case "custom":
      apiKey = settings.customAgentWebApiKey;
      break;
    default:
      return undefined;
  }
  if (typeof apiKey !== "string" || apiKey.length === 0) return undefined;
  if (
    provider === "custom" &&
    (typeof settings.customAgentWebBaseUrl !== "string" ||
      settings.customAgentWebBaseUrl.trim().length === 0)
  ) {
    return undefined;
  }
  return {
    provider,
    apiKey,
    ...(provider === "custom" ? { baseUrl: settings.customAgentWebBaseUrl } : {}),
  };
}

function getAgentWebProvider(generation: AgentWebConfiguration): WebProvider | undefined {
  const current = getAgentWebConfiguration();
  if (
    !current ||
    current.provider !== generation.provider ||
    current.apiKey !== generation.apiKey ||
    current.baseUrl !== generation.baseUrl
  )
    return undefined;
  try {
    return createWebProvider(current);
  } catch {
    return undefined;
  }
}

function toAgentWebMcpServer(bridge: { url: string; token: string }): AcpMcpHttpServer {
  return {
    type: "http",
    name: "copilot-web",
    url: bridge.url,
    headers: [{ name: "Authorization", value: `Bearer ${bridge.token}` }],
  };
}
/**
 * Spawns the configured `@agentclientprotocol/codex-acp` package entry point.
 * The package exposes Codex as an ACP server over stdio. Authentication is inherited
 * from the adapter's bundled Codex login (`~/.codex/auth.json`) or
 * `OPENAI_API_KEY` / `CODEX_API_KEY` exported in the user's shell — we
 * deliberately do not inject keys so ChatGPT-login subscriptions work
 * transparently.
 */
export class CodexBackend implements AcpBackend {
  readonly id = "codex" as const;
  readonly displayName = "Codex";

  /**
   * Where the spawned Codex keeps its state, taken from the env we actually gave it so a
   * user who redirects `CODEX_HOME` has their caps read from the same place Codex writes
   * them. Null until the first spawn, because until then there is no Codex to read from.
   */
  private codexHome: string | null = null;

  constructor(private readonly clientVersion = "") {}

  async buildSpawnDescriptor(ctx: {
    vaultBasePath: string;
    vaultName?: string;
  }): Promise<AcpSpawnDescriptor> {
    const settings = getSettings();
    const descriptor = buildSimpleSpawnDescriptor(
      settings.agentMode?.backends?.codex?.binaryPath,
      "Codex adapter path not configured. Open Agent Mode settings and install or detect @agentclientprotocol/codex-acp.",
      sanitizeBuiltinSkillEnvOverrides(settings.agentMode?.backends?.codex?.envOverrides),
      {
        // Builtin skills consume plugin-managed runtime paths and credentials.
        ...(await buildBuiltinSkillEnv(this.clientVersion, ctx.vaultBasePath, ctx.vaultName)),
        // The supported adapter derives its initial ACP mode from this variable.
        // User env overrides still win.
        INITIAL_AGENT_MODE: "agent",
      }
    );
    // Forward the shared built-in prompt — the Copilot base framing, tool
    // guidance, and pill-syntax directive — through the current adapter's
    // CODEX_CONFIG JSON. Codex appends `developer_instructions` to its own base
    // prompt, so this adds the Obsidian-vault framing on top. Read at spawn
    // time; the host restarts Codex on prompt changes via
    // `restartOnSystemPromptChange`.
    const directive = buildAgentSystemPrompt();
    // Vault-selection sandbox: when a first-turn selection is active, name the
    // workspace root the scoped sessions run in. The sandbox itself is codex's
    // pinned `sandbox_mode: "workspace-write"` against the SESSION cwd, which
    // the manager sets to this same root at session-open (ACP carries cwd per
    // session; this spawn descriptor has no cwd slot). A root equal to the
    // vault root is no narrowing, so it earns no directive.
    const vaultRoot = ctx.vaultBasePath.replace(/[/\\]+$/, "");
    const scope = getActiveAgentScope();
    const workspaceRoot = scope ? agentScopeWorkspaceRoot(scope, vaultRoot) : undefined;
    descriptor.env.CODEX_CONFIG = mergeCodexConfigEnv(descriptor.env.CODEX_CONFIG, directive, {
      workspaceRoot:
        workspaceRoot !== undefined && workspaceRoot !== vaultRoot ? workspaceRoot : undefined,
    });
    // Deliberately no `project_doc_fallback_filenames=["project.md"]`: project.md is metadata,
    // while Codex discovers the canonical AGENTS.md instructions from the session cwd.
    const entryPath = resolveSupportedCodexAcpEntry(descriptor.command);
    // Native bundles include their runtime; only user-owned npm entries need Node.
    // https://github.com/Brevilabs/obsidian-copilot-private/issues/379
    const nodePath =
      process.platform === "win32" && entryPath.endsWith(".js")
        ? await detectBinary("node")
        : undefined;
    const invocation = buildCodexAcpInvocation(
      entryPath,
      descriptor.args,
      descriptor.env,
      process.platform,
      nodePath ?? undefined
    );
    this.codexHome = invocation.env.CODEX_HOME ?? defaultCodexHome();
    const generation = getAgentWebConfiguration();
    if (generation === undefined) return { ...descriptor, ...invocation };
    const configuredProvider = getAgentWebProvider(generation);
    if (!configuredProvider) return { ...descriptor, ...invocation };

    const getProvider = (): WebProvider | undefined => getAgentWebProvider(generation);
    const bridge = await startAgentWebBridge({ getProvider });
    // Settings can change while the listener is starting. Do not return a
    // descriptor for a generation that is already disabled or missing its key.
    if (!getProvider()) {
      await bridge.dispose();
      return { ...descriptor, ...invocation };
    }
    return {
      ...descriptor,
      ...invocation,
      mcpServers: [toAgentWebMcpServer(bridge)],
      dispose: () => bridge.dispose(),
    };
  }

  /**
   * Codex's caps, read back from the rollout it writes for every turn. See
   * `codexPlanUsage.ts` for why that file is the only structured source a client has.
   * Before the first spawn there is no Codex to read from, so there is no news yet.
   */
  async readPlanUsage(): Promise<PlanUsageReading> {
    return this.codexHome === null ? { kind: "unavailable" } : readCodexPlanUsage(this.codexHome);
  }
}
