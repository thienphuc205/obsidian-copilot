import { logError, logInfo, logWarn } from "@/logger";
import type CopilotPlugin from "@/main";
import { getSettings } from "@/settings/model";
import { App, FileSystemAdapter, Platform } from "obsidian";
import { MethodUnsupportedError } from "./errors";
import type {
  BackendDescriptor,
  BackendId,
  BackendModelCatalog,
  BackendProcess,
  BackendState,
  EffortOption,
  SessionId,
} from "./types";

/** A stalled backend stop must not hold plugin teardown indefinitely. */
const PRELOADER_PROCESS_STOP_TIMEOUT_MS = 5_000;

/**
 * Warm result of a successful preload. The manager takes ownership of the
 * already-started process but starts a fresh session for the user's chat.
 */
export interface WarmBackend {
  proc: BackendProcess;
}

/**
 * Plugin-lifetime owner of per-backend model discovery and the running probe
 * subprocess that produced it. Backends expose model catalogs only as a
 * side-effect of session creation / resume / load, so without this preload
 * the picker would show no entries for non-active backends.
 *
 * Probes once per backend at startup: prefer resume of a persisted probe
 * sessionId, fall back to load, then to new (and persist the new id so the
 * next reload can reuse it — keeps the agent-side session store at one stale
 * entry per machine instead of growing with each reload).
 *
 * The probe subprocess is **kept warm** until the manager consumes it via
 * `takeWarm(backendId)`. That removes the warm subprocess spawn from the
 * critical path of the first chat-open: instead of preload booting a
 * subprocess just to read its catalog and immediately shutting it down,
 * the same subprocess becomes the manager's backend process on first use.
 */
export class AgentModelPreloader {
  private readonly warm = new Map<BackendId, WarmBackend>();
  // Probe-owned discovery data. Live sessions never write this map.
  private readonly modelCatalogCache = new Map<BackendId, BackendModelCatalog>();
  // Per-backend effort options keyed by baseModelId, discovered by probing each
  // enabled model once after the catalog loads (opencode only advertises effort
  // for the active model, so the catalog itself carries none). Read by the
  // picker via `AgentSessionManager.getEffortCatalog`.
  private readonly effortCatalog = new Map<BackendId, Record<string, EffortOption[]>>();
  private readonly inflight = new Map<BackendId, Promise<void>>();
  // Backends whose in-flight probe baked stale spawn config and must re-probe
  // once it settles. Set by `refresh`, drained by the probe chain. Coalesces
  // the burst of config writes one BYOK save produces into a single re-probe.
  private readonly pendingRefresh = new Set<BackendId>();
  private readonly listeners = new Set<() => void>();
  // Per-warm-entry exit-listener teardowns. Wired when the warm entry is
  // recorded so we can clear it if the probe subprocess dies before the
  // manager takes ownership.
  private readonly warmExitUnsubs = new Map<BackendId, () => void>();
  // Every probe process is owned from creation until it is handed to the
  // manager or stopped. This includes processes whose start or probe RPC is
  // still pending, so shutdown can stop them without awaiting that operation.
  private readonly ownedProcs = new Set<BackendProcess>();
  // A late probe cleanup must reuse the shutdown already issued by teardown or
  // refresh. Weak keys avoid retaining completed probe processes forever.
  private readonly procShutdowns = new WeakMap<BackendProcess, Promise<void>>();
  private readonly pendingStops = new Set<Promise<void>>();
  private disposed = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly app: App,
    private readonly plugin: CopilotPlugin,
    private readonly resolveDescriptor: (id: BackendId) => BackendDescriptor | undefined
  ) {}

  /**
   * Latest model catalog discovered by this backend's probe, or null before discovery.
   * @param backendId - Backend whose shared discovery result should be read.
   */
  getCachedModelCatalog(backendId: BackendId): BackendModelCatalog | null {
    return this.modelCatalogCache.get(backendId) ?? null;
  }

  /** Per-model effort options discovered by the post-catalog prefetch, or null. */
  getEffortCatalog(backendId: BackendId): Record<string, EffortOption[]> | null {
    return this.effortCatalog.get(backendId) ?? null;
  }

  /**
   * Remove all cached discovery for `backendId` after its backend is restarted.
   * Drops the warm subprocess if it hasn't been taken yet so a fresh probe
   * runs on the next `preload(backendId)` call.
   */
  clearCached(backendId: BackendId): void {
    if (this.disposed) return;
    let changed = false;
    if (this.modelCatalogCache.delete(backendId)) changed = true;
    if (this.effortCatalog.delete(backendId)) changed = true;
    const warm = this.warm.get(backendId);
    if (warm) {
      this.warm.delete(backendId);
      this.warmExitUnsubs.get(backendId)?.();
      this.warmExitUnsubs.delete(backendId);
      void this.stopOwnedProcess(backendId, warm.proc);
      changed = true;
    }
    if (changed) this.notify();
  }

  /**
   * Hand the warm backend process to the manager. Single-shot: removes the
   * entry so subsequent callers see `null` and the manager owns lifetime of
   * the process from here on.
   */
  takeWarm(backendId: BackendId): WarmBackend | null {
    if (this.disposed) return null;
    const entry = this.warm.get(backendId);
    if (!entry) return null;
    this.warm.delete(backendId);
    this.warmExitUnsubs.get(backendId)?.();
    this.warmExitUnsubs.delete(backendId);
    this.ownedProcs.delete(entry.proc);
    return entry;
  }

  /**
   * Snapshot of the still-warm probe processes, for read-only RPC sweeps
   * (the history surface's `listSessions`). Unlike {@link takeWarm} this
   * does NOT consume the entries — the preloader keeps ownership, and the
   * manager can still adopt the proc later.
   */
  getWarmProcs(): Array<{ backendId: BackendId; proc: BackendProcess }> {
    return Array.from(this.warm.entries(), ([backendId, entry]) => ({
      backendId,
      proc: entry.proc,
    }));
  }

  /** Best-effort probe; failures are logged and swallowed. Dedupes per backend. */
  preload(backendId: BackendId): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const existing = this.inflight.get(backendId);
    if (existing) return existing;
    return this.startProbeChain(backendId);
  }

  /**
   * Re-probe `backendId` against current settings after a spawn-config change
   * (a new API key, an enabled-models edit, …). Unlike {@link preload} — whose
   * dedupe is right for "ensure a warm proc exists" — a config change may land
   * *after* an in-flight probe baked its spawn config, so that probe would
   * cache a stale catalog and the picker would flag the freshly-enabled model
   * "not offered by agent" until a reload.
   *
   * A single BYOK save lands several writes (provider row → key → enabled
   * models) in a burst, each calling here. The first drops the warm entry and
   * starts a fresh probe; the rest just flag a trailing re-run, so exactly one
   * more probe runs once the in-flight one finishes — observing the settled
   * settings. This coalesces the burst into a single final re-probe without a
   * debounce timer.
   *
   * Returns the probe-chain promise (for preload-status wiring), or `null` when
   * nothing is warm or in flight — a config change for a never-probed backend
   * must not spin one up.
   */
  refresh(backendId: BackendId): Promise<void> | null {
    if (this.disposed) return null;
    const existing = this.inflight.get(backendId);
    if (existing) {
      this.pendingRefresh.add(backendId);
      return existing;
    }
    if (this.getCachedModelCatalog(backendId) === null) return null;
    this.clearCached(backendId);
    return this.startProbeChain(backendId);
  }

  /**
   * Track a probe as one in-flight promise so concurrent callers dedupe against
   * the whole chain, including any trailing re-runs requested via
   * {@link refresh}.
   */
  private startProbeChain(backendId: BackendId): Promise<void> {
    const promise = this.runProbeChain(backendId).finally(() => {
      this.inflight.delete(backendId);
      this.pendingRefresh.delete(backendId);
    });
    this.inflight.set(backendId, promise);
    return promise;
  }

  private async runProbeChain(backendId: BackendId): Promise<void> {
    let round = 0;
    do {
      this.pendingRefresh.delete(backendId);
      // Later rounds replace a warm entry the prior probe set; drop it first so
      // the abandoned subprocess is shut down rather than leaked.
      if (round > 0) this.clearCached(backendId);
      round += 1;
      await this.runProbe(backendId);
    } while (this.pendingRefresh.has(backendId) && !this.disposed);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Stop every probe-owned process without waiting for a stalled probe or RPC.
   * Disposal is synchronous; repeated callers share the same cleanup promise.
   */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    // Mark disposal before creating any cleanup promise. Callers that race
    // shutdown must synchronously lose the right to start or adopt a probe.
    this.disposed = true;
    this.modelCatalogCache.clear();
    this.effortCatalog.clear();
    this.inflight.clear();
    this.pendingRefresh.clear();
    this.listeners.clear();
    const owned = new Set(this.ownedProcs);
    for (const [backendId, warm] of this.warm) {
      this.warmExitUnsubs.get(backendId)?.();
      owned.add(warm.proc);
    }
    this.warm.clear();
    this.warmExitUnsubs.clear();

    let resolveShutdown!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    this.shutdownPromise = completion;

    // Do not await inflight probe promises: a backend may never resolve a
    // startup or prefetch RPC. We do await each owned process stop, bounded by
    // stopOwnedProcess, so cooperative backends finish cleanly while a stuck
    // backend cannot wedge plugin teardown.
    const stops = new Set(this.pendingStops);
    for (const proc of owned) stops.add(this.stopOwnedProcess("shutdown", proc));
    void Promise.allSettled(stops).then(() => resolveShutdown());
    return completion;
  }

  private stopOwnedProcess(backendId: BackendId, proc: BackendProcess): Promise<void> {
    const existing = this.procShutdowns.get(proc);
    if (existing) return existing;

    let timer: number | null = null;
    let finished = false;
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    this.procShutdowns.set(proc, completion);
    this.pendingStops.add(completion);

    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      this.ownedProcs.delete(proc);
      this.pendingStops.delete(completion);
      resolveCompletion();
    };

    timer = window.setTimeout(() => {
      logWarn(
        `[AgentMode] preload ${backendId}: backend stop exceeded ${PRELOADER_PROCESS_STOP_TIMEOUT_MS}ms`
      );
      finish();
    }, PRELOADER_PROCESS_STOP_TIMEOUT_MS);

    try {
      void Promise.resolve(proc.shutdown()).then(
        () => finish(),
        (error) => {
          logWarn(`[AgentMode] preload ${backendId}: backend shutdown failed`, error);
          finish();
        }
      );
    } catch (error) {
      logWarn(`[AgentMode] preload ${backendId}: backend shutdown threw`, error);
      finish();
    }

    return completion;
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (e) {
        logWarn("[AgentMode] preload listener threw", e);
      }
    }
  }

  private async runProbe(backendId: BackendId): Promise<void> {
    if (this.disposed) return;
    if (Platform.isMobile) return;
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const cwd = adapter.getBasePath();

    const descriptor = this.resolveDescriptor(backendId);
    if (!descriptor) {
      logWarn(`[AgentMode] preload skipped: unknown backend ${backendId}`);
      return;
    }
    if (descriptor.getInstallState(getSettings()).kind !== "ready") return;

    const proc = descriptor.createBackendProcess({
      plugin: this.plugin,
      app: this.app,
      clientVersion: this.plugin.manifest.version,
      descriptor,
    });
    this.ownedProcs.add(proc);

    let probe: { sessionId: SessionId; state: BackendState } | null = null;
    let retained = false;
    try {
      if (this.disposed) return;
      await proc.start?.();
      if (this.disposed) return;
      const storedId = descriptor.getProbeSessionId?.(getSettings());
      probe = await this.fetchInitialState(proc, descriptor, backendId, storedId, cwd);
      if (this.disposed) return;

      if (!probe || (!probe.state.model && !probe.state.mode)) {
        if (probe) {
          logInfo(`[AgentMode] preload ${backendId}: agent did not report any initial state`);
        }
        return;
      }

      // Discover each enabled model's effort options before exposing the warm
      // entry. The probe loop switches the probe session's model and restores it,
      // so doing it now (rather than after the manager adopts the session) keeps
      // the adopted session on the original model. Cheap (~ms per switch) and
      // best-effort — failures leave the picker without prefetched effort.
      await this.runEffortPrefetch(backendId, descriptor, proc, probe.sessionId, probe.state);
      if (this.disposed) return;

      // Probe succeeded — retain the running subprocess as a warm entry so
      // the first chat-open can adopt it instead of paying another spawn +
      // initialize round-trip.
      const warm: WarmBackend = {
        proc,
      };
      const exitUnsub = proc.onExit(() => {
        if (this.disposed) return;
        // Subprocess died before the manager claimed it. Drop the warm
        // entry; next createSession will spawn a fresh one through the
        // descriptor.
        if (this.warm.get(backendId) === warm) {
          this.warm.delete(backendId);
          this.modelCatalogCache.delete(backendId);
          this.effortCatalog.delete(backendId);
          this.warmExitUnsubs.delete(backendId);
          this.notify();
        }
      });
      this.warm.set(backendId, warm);
      this.modelCatalogCache.set(backendId, {
        availableModels: probe.state.model?.availableModels ?? null,
      });
      this.warmExitUnsubs.set(backendId, exitUnsub);
      this.ownedProcs.delete(proc);
      retained = true;
      logProbeResult(backendId, "session probe", probe.state);
      this.notify();
    } catch (err) {
      if (!this.disposed) logError(`[AgentMode] preload ${backendId} failed`, err);
    } finally {
      if (!retained) await this.stopOwnedProcess(backendId, proc);
    }
  }

  /**
   * Probe each enabled model's effort options on the just-created probe session
   * via the descriptor's optional `prefetchEffortCatalog`, caching the result so
   * the picker can show effort steppers for every model before one is selected.
   * Best-effort: no hook, no model state, or any error leaves the catalog empty.
   */
  private async runEffortPrefetch(
    backendId: BackendId,
    descriptor: BackendDescriptor,
    proc: BackendProcess,
    sessionId: SessionId,
    state: BackendState
  ): Promise<void> {
    if (!descriptor.prefetchEffortCatalog || !state.model) return;
    const enabledModels = descriptor.getEnabledModelEntries?.(getSettings());
    if (!enabledModels || enabledModels.length === 0) return;
    try {
      const catalog = await descriptor.prefetchEffortCatalog({
        proc,
        sessionId,
        modelState: state.model,
        enabledModels,
        isAborted: () => this.disposed,
      });
      if (this.disposed) return;
      if (Object.keys(catalog).length > 0) this.effortCatalog.set(backendId, catalog);
    } catch (e) {
      logWarn(`[AgentMode] preload ${backendId}: effort prefetch failed`, e);
    }
  }

  private async fetchInitialState(
    proc: BackendProcess,
    descriptor: BackendDescriptor,
    backendId: BackendId,
    storedId: string | undefined,
    cwd: string
  ): Promise<{ sessionId: SessionId; state: BackendState }> {
    type Strategy = {
      label: string;
      sessionId: string;
      run: () => Promise<{ sessionId: string; state: BackendState }>;
    };
    const strategies: Strategy[] = [];
    if (storedId) {
      strategies.push({
        label: `resumed probe session ${storedId}`,
        sessionId: storedId,
        run: () => proc.resumeSession({ sessionId: storedId, cwd }),
      });
      strategies.push({
        label: `loaded probe session ${storedId}`,
        sessionId: storedId,
        run: () => proc.loadSession({ sessionId: storedId, cwd }),
      });
    }

    for (const { label, sessionId, run } of strategies) {
      try {
        // Register a no-op handler before the call so updates emitted
        // during the call are demuxed against this sessionId rather than
        // buffered indefinitely. The manager overrides this with the real
        // handler when it adopts the session.
        proc.registerSessionHandler(sessionId, () => {});
        const resp = await run();
        logInfo(`[AgentMode] preload ${backendId}: ${label}`);
        return { sessionId: resp.sessionId, state: resp.state };
      } catch (err) {
        if (!(err instanceof MethodUnsupportedError)) {
          logWarn(`[AgentMode] preload ${backendId}: ${label} failed (will fall back)`, err);
        }
      }
    }

    const resp = await proc.newSession({ cwd });
    proc.registerSessionHandler(resp.sessionId, () => {});
    logInfo(`[AgentMode] preload ${backendId}: created probe session ${resp.sessionId}`);
    if (descriptor.persistProbeSessionId) {
      try {
        await descriptor.persistProbeSessionId(resp.sessionId, this.plugin);
      } catch (e) {
        logWarn(`[AgentMode] preload ${backendId}: persistProbeSessionId failed`, e);
      }
    }
    return { sessionId: resp.sessionId, state: resp.state };
  }
}

function logProbeResult(backendId: BackendId, label: string, state: BackendState): void {
  const ids = state.model?.availableModels.map((m) => m.baseModelId).join(", ") ?? "";
  const modeOpts = state.mode?.options.map((o) => o.value).join(", ") ?? "";
  const currentBaseId = state.model?.current.baseModelId ?? "-";
  const currentEntry = state.model?.availableModels.find((e) => e.baseModelId === currentBaseId);
  const effortOpts = currentEntry?.effortOptions.map((o) => o.value ?? "default").join(", ") ?? "";
  logInfo(
    `[AgentMode] preload ${backendId} (${label}): models=[${ids}] (current=${currentBaseId}), ` +
      `mode=[${modeOpts}] effort=[${effortOpts}]`
  );
}
