import { isSelfHostedUrl } from "@/modelManagement/providers/isSelfHostedProvider";

/**
 * Timeout granted to one-shot LLM operations when the active model runs on a
 * self-hosted server (Ollama, LM Studio, any loopback / LAN endpoint). Local
 * models are far slower than hosted APIs at equal token counts, so the shared
 * 30-second cloud timeout systematically kills auxiliary LLM calls (query
 * expansion) against them, silently degrading those features.
 */
export const LOCAL_LLM_TIMEOUT_MS = 120_000;

/**
 * Resolve the timeout for one auxiliary LLM operation: the configured default,
 * or the long local budget when the active model points at a self-hosted URL.
 * Detection failures never affect the caller — they fall back to the default.
 */
export async function resolveLocalAwareTimeout(configuredMs: number): Promise<number> {
  try {
    // Dynamic import keeps module-load side effects out of synthetic tests
    // (mirroring safeGetChatModel in src/search/v3/TieredLexicalRetriever.ts).
    const mod = await import("@/LLMProviders/chatModelManager");
    const model = mod.default.getInstance().getActiveModel();
    if (!model) return configuredMs;
    return isSelfHostedUrl(model.baseUrl) ? LOCAL_LLM_TIMEOUT_MS : configuredMs;
  } catch {
    return configuredMs;
  }
}
