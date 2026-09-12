import {
  CHAT_ATTACHMENT_REF_SCHEMA_VERSION,
  MAX_CHAT_ATTACHMENT_REFS,
  normalizeLocalAttachmentRefs,
  type LocalAttachmentRef,
} from "@/agentMode/session/chatAttachmentRefs";
import type { ProjectScopeId } from "@/agentMode/session/scope";
import { isValidAttachmentVaultId } from "@/context/assets/attachmentStoreTypes";

/** The host identity against which one volatile staging bucket is bound. */
export interface SessionLocalAttachmentTarget {
  readonly sessionId: string;
  readonly projectId: ProjectScopeId;
  readonly vaultId: string;
}

/** The live host lookup used to reject stale session, project, or vault state. */
export type SessionLocalAttachmentLiveTargetGetter = () =>
  | SessionLocalAttachmentTarget
  | null
  | Promise<SessionLocalAttachmentTarget | null>;

/** An immutable, inert view of the references staged for one session. */
export interface SessionLocalAttachmentSnapshot {
  readonly target: SessionLocalAttachmentTarget;
  readonly refs: readonly LocalAttachmentRef[];
}

/** Input for one all-or-nothing staging operation. */
export interface SessionLocalAttachmentStageRequest {
  readonly target: SessionLocalAttachmentTarget;
  readonly refs: unknown;
}

/** Input for removing one staged reference. */
export interface SessionLocalAttachmentRemoveRequest {
  readonly target: SessionLocalAttachmentTarget;
  readonly attachmentId: string;
}

/** Options for the session-owned staging factory. */
export interface SessionLocalAttachmentStagingOptions {
  readonly target: SessionLocalAttachmentTarget;
  readonly getLiveTarget: SessionLocalAttachmentLiveTargetGetter;
}

/** Host-facing options for obtaining a session's staging bucket. */
export interface AgentSessionLocalAttachmentStagingOptions {
  readonly vaultId: string;
  readonly getLiveTarget: SessionLocalAttachmentLiveTargetGetter;
}

/** The small volatile staging surface exposed to command-facing code. */
export interface SessionLocalAttachmentStaging {
  /** Return inert metadata; the snapshot is not an authorization capability. */
  getSnapshot(): SessionLocalAttachmentSnapshot;
  /** Add a validated batch without partially applying malformed input. */
  stage(request: SessionLocalAttachmentStageRequest): Promise<SessionLocalAttachmentSnapshot>;
  /** Remove one reference after rechecking the caller and live host identity. */
  remove(request: SessionLocalAttachmentRemoveRequest): Promise<SessionLocalAttachmentSnapshot>;
  /** Remove all volatile references after rechecking the caller and live host identity. */
  clear(target: SessionLocalAttachmentTarget): Promise<SessionLocalAttachmentSnapshot>;
  /** Refresh only the trusted live lookup; the bound target and refs remain unchanged. */
  updateLiveTargetGetter(getLiveTarget: SessionLocalAttachmentLiveTargetGetter): void;
  /** Invalidate volatile state synchronously without touching persisted blobs. */
  dispose(): void;
}

export type SessionLocalAttachmentStagingErrorCode =
  | "disposed"
  | "invalid-target"
  | "stale-target"
  | "invalid-refs"
  | "foreign-vault"
  | "ref-limit";

/** A typed fail-closed error from the inert session-local staging boundary. */
export class SessionLocalAttachmentStagingError extends Error {
  readonly code: SessionLocalAttachmentStagingErrorCode;

  constructor(code: SessionLocalAttachmentStagingErrorCode, message: string) {
    super(message);
    this.name = "SessionLocalAttachmentStagingError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const EMPTY_REFS: readonly LocalAttachmentRef[] = Object.freeze([]);

/**
 * Create one volatile staging bucket bound to a session/project/vault tuple.
 * The factory performs no attachment I/O and owns no persistence or backend
 * capability; its live-target callback is the only authority used at mutation.
 *
 * @param options The immutable binding and trusted current-host lookup.
 * @returns The session-local staging surface.
 */
export function createSessionLocalAttachmentStaging(
  options: SessionLocalAttachmentStagingOptions
): SessionLocalAttachmentStaging {
  const boundTarget = normalizeTarget(options.target);
  let getLiveTarget = validateLiveTargetGetter(options.getLiveTarget);
  let liveTargetGetterGeneration = 0;
  let disposed = false;
  let snapshot = makeSnapshot(boundTarget, EMPTY_REFS);
  let tail: Promise<void> = Promise.resolve();
  const disposedError = new SessionLocalAttachmentStagingError(
    "disposed",
    "Session-local attachment staging is disposed"
  );
  let rejectDisposed: ((reason?: unknown) => void) | null = null;
  const disposedPromise = new Promise<never>((_, reject) => {
    rejectDisposed = reject;
  });
  // A staging bucket can be disposed before any mutation is waiting on the
  // live lookup. Marking this rejection handled prevents that synchronous
  // teardown path from producing an unhandled-rejection warning.
  void disposedPromise.catch(() => undefined);

  const ensureOpen = (): void => {
    if (disposed) throw disposedError;
  };

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  const validateMutationTarget = (candidate: unknown): void => {
    ensureOpen();
    const target = normalizeTarget(candidate);
    if (!sameTarget(boundTarget, target)) {
      throw new SessionLocalAttachmentStagingError(
        "stale-target",
        "Attachment staging target no longer matches this session"
      );
    }
  };

  const validateLiveTarget = async (): Promise<void> => {
    ensureOpen();
    const generation = liveTargetGetterGeneration;
    const liveLookup = Promise.resolve().then(() => getLiveTarget());
    let liveCandidate: SessionLocalAttachmentTarget | null;
    try {
      liveCandidate = await Promise.race([liveLookup, disposedPromise]);
    } catch (error) {
      if (error === disposedError) throw error;
      throw new SessionLocalAttachmentStagingError(
        "stale-target",
        "The current attachment staging target is unavailable"
      );
    }
    ensureOpen();
    if (generation !== liveTargetGetterGeneration) {
      throw new SessionLocalAttachmentStagingError(
        "stale-target",
        "The live attachment staging authority changed during the mutation"
      );
    }

    let liveTarget: SessionLocalAttachmentTarget;
    try {
      liveTarget = normalizeTarget(liveCandidate);
    } catch {
      throw new SessionLocalAttachmentStagingError(
        "stale-target",
        "The current attachment staging target is invalid"
      );
    }
    if (!sameTarget(boundTarget, liveTarget)) {
      throw new SessionLocalAttachmentStagingError(
        "stale-target",
        "The current session, project, or vault does not match staged attachments"
      );
    }
  };

  const validateRefs = (value: unknown): readonly LocalAttachmentRef[] => {
    if (!Array.isArray(value)) {
      throw new SessionLocalAttachmentStagingError(
        "invalid-refs",
        "Attachment references must be an array"
      );
    }
    if (value.length > MAX_CHAT_ATTACHMENT_REFS) {
      throw new SessionLocalAttachmentStagingError(
        "ref-limit",
        `At most ${MAX_CHAT_ATTACHMENT_REFS} attachment references may be staged`
      );
    }
    if (value.length === 0) return EMPTY_REFS;

    const refs = normalizeLocalAttachmentRefs(value);
    if (refs.length === 0) {
      throw new SessionLocalAttachmentStagingError(
        "invalid-refs",
        "Attachment references are malformed or oversized"
      );
    }
    if (refs.some((ref) => ref.vaultId !== boundTarget.vaultId)) {
      throw new SessionLocalAttachmentStagingError(
        "foreign-vault",
        "Attachment references must belong to the bound vault"
      );
    }
    return refs;
  };

  const validateAttachmentId = (value: unknown): string => {
    const refs = normalizeLocalAttachmentRefs([
      {
        schemaVersion: CHAT_ATTACHMENT_REF_SCHEMA_VERSION,
        vaultId: boundTarget.vaultId,
        attachmentId: value,
      },
    ]);
    if (refs.length !== 1) {
      throw new SessionLocalAttachmentStagingError("invalid-refs", "Attachment id is malformed");
    }
    return refs[0].attachmentId;
  };

  const staging: SessionLocalAttachmentStaging = {
    getSnapshot: () => snapshot,

    stage: (request) =>
      enqueue(async () => {
        validateMutationTarget(request.target);
        const refs = validateRefs(request.refs);
        await validateLiveTarget();

        if (refs.length === 0) return snapshot;
        const uniqueCount = new Set(
          [...snapshot.refs, ...refs].map((ref) => `${ref.vaultId}\u0000${ref.attachmentId}`)
        ).size;
        if (uniqueCount > MAX_CHAT_ATTACHMENT_REFS) {
          throw new SessionLocalAttachmentStagingError(
            "ref-limit",
            `At most ${MAX_CHAT_ATTACHMENT_REFS} attachment references may be staged`
          );
        }
        const merged = normalizeLocalAttachmentRefs([...snapshot.refs, ...refs]);
        if (merged.length === 0) {
          throw new SessionLocalAttachmentStagingError(
            "invalid-refs",
            "Attachment references are malformed or oversized"
          );
        }
        if (merged.length === snapshot.refs.length) return snapshot;
        snapshot = makeSnapshot(boundTarget, merged);
        return snapshot;
      }),

    remove: (request) =>
      enqueue(async () => {
        validateMutationTarget(request.target);
        const attachmentId = validateAttachmentId(request.attachmentId);
        await validateLiveTarget();

        const nextRefs = snapshot.refs.filter((ref) => ref.attachmentId !== attachmentId);
        if (nextRefs.length === snapshot.refs.length) return snapshot;
        snapshot = makeSnapshot(boundTarget, Object.freeze(nextRefs));
        return snapshot;
      }),

    clear: (target) =>
      enqueue(async () => {
        validateMutationTarget(target);
        await validateLiveTarget();
        if (snapshot.refs.length === 0) return snapshot;
        snapshot = makeSnapshot(boundTarget, EMPTY_REFS);
        return snapshot;
      }),

    updateLiveTargetGetter: (nextGetter) => {
      ensureOpen();
      getLiveTarget = validateLiveTargetGetter(nextGetter);
      liveTargetGetterGeneration += 1;
    },

    dispose: () => {
      if (disposed) return;
      disposed = true;
      snapshot = makeSnapshot(boundTarget, EMPTY_REFS);
      rejectDisposed?.(disposedError);
      rejectDisposed = null;
    },
  };

  return staging;
}

function makeSnapshot(
  target: SessionLocalAttachmentTarget,
  refs: readonly LocalAttachmentRef[]
): SessionLocalAttachmentSnapshot {
  return Object.freeze({ target, refs });
}

function normalizeTarget(value: unknown): SessionLocalAttachmentTarget {
  if (!isPlainRecord(value)) throw invalidTargetError();
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !keys.includes("sessionId") ||
    !keys.includes("projectId") ||
    !keys.includes("vaultId")
  ) {
    throw invalidTargetError();
  }
  if (
    !isSafeIdentity(value.sessionId) ||
    !isSafeIdentity(value.projectId) ||
    !isValidAttachmentVaultId(value.vaultId)
  ) {
    throw invalidTargetError();
  }
  return Object.freeze({
    sessionId: value.sessionId,
    projectId: value.projectId,
    vaultId: value.vaultId,
  });
}

function validateLiveTargetGetter(
  value: SessionLocalAttachmentLiveTargetGetter
): SessionLocalAttachmentLiveTargetGetter {
  if (typeof value !== "function") {
    throw new SessionLocalAttachmentStagingError(
      "invalid-target",
      "A trusted live attachment target lookup is required"
    );
  }
  return value;
}

function sameTarget(
  left: SessionLocalAttachmentTarget,
  right: SessionLocalAttachmentTarget
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.projectId === right.projectId &&
    left.vaultId === right.vaultId
  );
}

function invalidTargetError(): SessionLocalAttachmentStagingError {
  return new SessionLocalAttachmentStagingError(
    "invalid-target",
    "Attachment staging target must identify one session, project, and vault"
  );
}

function isSafeIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- identity values must not carry control bytes
    !/[\u0000-\u001F\u007F]/u.test(value)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
