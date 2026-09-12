/**
 * Bounded scheduler for background image auto-indexing. The queue owns only
 * scheduling: per-note dedupe with a debounce window, a hard cap on queued
 * note paths (oldest evicted), and bounded-concurrency FIFO draining. All
 * Obsidian, model, and store work belongs to the injected runner, so this
 * module stays pure and testable without the plugin host.
 */

/** Terminal states one runner run can report for a note. */
export type ImageAutoIndexRunResult = "described" | "skipped" | "failed";

/** Hard cap on queued note paths; enqueueing beyond it evicts the oldest. */
export const IMAGE_AUTO_INDEX_MAX_QUEUED_NOTE_PATHS = 200;

/**
 * The work the queue schedules on behalf of one note. The runner owns every
 * bound about HOW a note is processed (per-note image cap, model calls,
 * persistence) and only receives the note path plus the queue's configured
 * per-note image cap, which it may honor or ignore.
 */
export interface ImageAutoIndexQueueOptions {
  /**
   * Runs the describe flow for one note. Resolving "failed" is a handled
   * outcome (e.g. every image failed); throwing is an unexpected failure and
   * reaches {@link ImageAutoIndexQueueOptions.onError}.
   */
  readonly describeNoteImages: (
    notePath: string,
    maxImages: number
  ) => Promise<ImageAutoIndexRunResult>;
  /** Sink for unexpected runner failures; the queue never logs on its own. */
  readonly onError?: (error: unknown, notePath: string) => void;
  /** Maximum note runs in flight during one drain batch; defaults to 2. */
  readonly maxConcurrent?: number;
  /** Per-note image cap forwarded to the runner; defaults to 20. */
  readonly maxPerNote?: number;
  /** Minimum milliseconds between a note's last enqueue and its run. */
  readonly debounceMs?: number;
}

export interface ImageAutoIndexQueue {
  /**
   * Queue one note for describing. A note that is already queued is not
   * re-queued but its last-enqueue time is refreshed (extending its debounce);
   * a note whose run is in flight is not re-queued either, but a run finished
   * after such a request queues it again so the change is not lost.
   */
  enqueueNote(notePath: string): void;
  /** Number of notes waiting to run (running notes are not counted). */
  pendingCount(): number;
  /**
   * Drain every currently-debounce-eligible note in FIFO order, up to
   * `maxConcurrent` runs in flight per batch. Notes still inside their
   * debounce window stay queued and are picked up by the queue's own timer.
   * Calling this while a drain is running awaits the same drain.
   */
  flush(): Promise<void>;
  /** Drop all pending work and timers. In-flight runs finish but are never re-queued. */
  stop(): void;
}

interface QueuedNote {
  readonly notePath: string;
  lastEnqueuedAt: number;
}

/**
 * Create the background image auto-index queue.
 *
 * Scheduling contract: each queued note runs once its debounce window
 * (`debounceMs` since its most recent enqueue) has elapsed; drains dispatch
 * notes in queue order, running at most `maxConcurrent` notes per batch and
 * finishing each batch before the next. The queue schedules its own timer so
 * an enqueued note eventually runs without further `flush()` calls. The
 * queue holds at most {@link IMAGE_AUTO_INDEX_MAX_QUEUED_NOTE_PATHS} paths —
 * enqueueing more evicts the longest-queued note.
 *
 * @param options - Injected runner plus bounds; see
 * {@link ImageAutoIndexQueueOptions}.
 * @returns The queue handle.
 */
export function createImageAutoIndexQueue(
  options: ImageAutoIndexQueueOptions
): ImageAutoIndexQueue {
  const debounceMs = options.debounceMs ?? 3000;
  const maxPerNote = options.maxPerNote ?? 20;
  const maxConcurrent = options.maxConcurrent ?? 2;
  const onError = options.onError;

  const queue: QueuedNote[] = [];
  const queuedByPath = new Map<string, QueuedNote>();
  const runningPaths = new Set<string>();
  /** Last-enqueue times recorded for notes whose run was already in flight. */
  const requeuedWhileRunning = new Map<string, number>();
  let stopped = false;
  let drainPromise: Promise<void> | null = null;
  let timer: number | null = null;
  let timerDeadline: number | null = null;

  function pushNote(notePath: string, lastEnqueuedAt: number): void {
    const note = { notePath, lastEnqueuedAt };
    queue.push(note);
    queuedByPath.set(notePath, note);
    while (queue.length > IMAGE_AUTO_INDEX_MAX_QUEUED_NOTE_PATHS) {
      const evicted = queue.shift();
      if (evicted) queuedByPath.delete(evicted.notePath);
    }
  }

  function takeEligibleBatch(): QueuedNote[] {
    const nowMs = Date.now();
    const batch: QueuedNote[] = [];
    for (const note of queue) {
      if (batch.length >= maxConcurrent) break;
      if (nowMs - note.lastEnqueuedAt >= debounceMs) batch.push(note);
    }
    if (batch.length === 0) return batch;
    for (const note of batch) {
      queuedByPath.delete(note.notePath);
      runningPaths.add(note.notePath);
    }
    const taken = new Set(batch);
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (taken.has(queue[index])) queue.splice(index, 1);
    }
    return batch;
  }

  async function runOne(note: QueuedNote): Promise<void> {
    try {
      await options.describeNoteImages(note.notePath, maxPerNote);
    } catch (error) {
      onError?.(error, note.notePath);
    } finally {
      runningPaths.delete(note.notePath);
      // A change arriving during the run asked for another pass; queue it
      // with the time of that request so its debounce starts there.
      const requeuedAt = requeuedWhileRunning.get(note.notePath);
      requeuedWhileRunning.delete(note.notePath);
      if (requeuedAt !== undefined) pushNote(note.notePath, requeuedAt);
    }
  }

  function ensureDrainScheduled(): void {
    if (stopped || drainPromise) return;
    const nowMs = Date.now();
    let earliestDeadline = Infinity;
    for (const note of queue) {
      earliestDeadline = Math.min(earliestDeadline, note.lastEnqueuedAt + debounceMs);
    }
    if (earliestDeadline === Infinity) {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
        timerDeadline = null;
      }
      return;
    }
    if (earliestDeadline <= nowMs) {
      void runDrain();
      return;
    }
    if (timer !== null && timerDeadline !== null && timerDeadline <= earliestDeadline) return;
    if (timer !== null) window.clearTimeout(timer);
    timerDeadline = earliestDeadline;
    timer = window.setTimeout(() => {
      timer = null;
      timerDeadline = null;
      void runDrain();
    }, earliestDeadline - nowMs);
  }

  function runDrain(): Promise<void> {
    if (drainPromise) return drainPromise;
    // The settled promise is registered before the body runs: a drain with an
    // empty first batch completes synchronously, and a plain `(async ...)()`
    // assignment afterwards would overwrite the `null` its finally just set.
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    drainPromise = done;
    void (async () => {
      try {
        for (;;) {
          const batch = takeEligibleBatch();
          if (batch.length === 0) break;
          await Promise.all(batch.map((note) => runOne(note)));
        }
      } finally {
        drainPromise = null;
      }
      // Late enqueues with a future debounce need their timer; during the
      // drain this call was a no-op, so it must run once more here.
      ensureDrainScheduled();
      resolveDone();
    })();
    return done;
  }

  return {
    enqueueNote(notePath: string): void {
      if (stopped) return;
      const nowMs = Date.now();
      const existing = queuedByPath.get(notePath);
      if (existing) {
        existing.lastEnqueuedAt = nowMs;
      } else if (!runningPaths.has(notePath)) {
        pushNote(notePath, nowMs);
      } else {
        requeuedWhileRunning.set(notePath, nowMs);
      }
      ensureDrainScheduled();
    },

    pendingCount(): number {
      return queue.length;
    },

    flush(): Promise<void> {
      if (stopped) return Promise.resolve();
      return runDrain();
    },

    stop(): void {
      stopped = true;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
        timerDeadline = null;
      }
      queue.length = 0;
      queuedByPath.clear();
      requeuedWhileRunning.clear();
    },
  };
}
