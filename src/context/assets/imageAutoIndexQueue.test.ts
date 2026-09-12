import {
  createImageAutoIndexQueue,
  IMAGE_AUTO_INDEX_MAX_QUEUED_NOTE_PATHS,
  type ImageAutoIndexRunResult,
} from "@/context/assets/imageAutoIndexQueue";

/** Runner that records how many runs were in flight simultaneously. */
function makeConcurrencyTrackingRunner() {
  let inFlight = 0;
  let maxInFlight = 0;
  const runner = jest.fn<Promise<ImageAutoIndexRunResult>, [string, number]>(
    async (_notePath: string, _maxImages: number) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return "described";
    }
  );
  return { runner, getMaxInFlight: () => maxInFlight };
}

/** Drain enough microtask rounds for one runner batch to fully settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe("imageAutoIndexQueue", () => {
  describe("createImageAutoIndexQueue()", () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it("drains queued notes in FIFO order, awaiting each run before the next at maxConcurrent 1", async () => {
      const { runner, getMaxInFlight } = makeConcurrencyTrackingRunner();
      const queue = createImageAutoIndexQueue({
        describeNoteImages: runner,
        maxConcurrent: 1,
        debounceMs: 0,
      });

      queue.enqueueNote("a.md");
      queue.enqueueNote("b.md");
      queue.enqueueNote("c.md");
      await queue.flush();

      expect(runner.mock.calls.map((call) => call[0])).toEqual(["a.md", "b.md", "c.md"]);
      expect(getMaxInFlight()).toBe(1);
      expect(queue.pendingCount()).toBe(0);
    });

    it("bounds concurrent runs to maxConcurrent during a drain", async () => {
      const { runner, getMaxInFlight } = makeConcurrencyTrackingRunner();
      const queue = createImageAutoIndexQueue({
        describeNoteImages: runner,
        maxConcurrent: 2,
        debounceMs: 0,
      });

      queue.enqueueNote("a.md");
      queue.enqueueNote("b.md");
      queue.enqueueNote("c.md");
      queue.enqueueNote("d.md");
      await queue.flush();

      expect(runner).toHaveBeenCalledTimes(4);
      expect(runner.mock.calls.map((call) => call[0])).toEqual(["a.md", "b.md", "c.md", "d.md"]);
      expect(getMaxInFlight()).toBe(2);
      expect(queue.pendingCount()).toBe(0);
    });

    it("dedupes a queued note while extending its debounce to the last enqueue", async () => {
      const runner = jest.fn<Promise<ImageAutoIndexRunResult>, [string, number]>(
        async () => "described"
      );
      const queue = createImageAutoIndexQueue({
        describeNoteImages: runner,
        debounceMs: 1000,
      });

      queue.enqueueNote("note.md");
      expect(queue.pendingCount()).toBe(1);

      jest.advanceTimersByTime(500);
      queue.enqueueNote("note.md");
      expect(queue.pendingCount()).toBe(1);
      queue.enqueueNote("other.md");
      expect(queue.pendingCount()).toBe(2);

      jest.advanceTimersByTime(999);
      await queue.flush();
      expect(runner).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      await queue.flush();

      expect(runner).toHaveBeenCalledTimes(2);
      expect(runner).toHaveBeenCalledWith("note.md", 20);
      expect(runner).toHaveBeenCalledWith("other.md", 20);
      expect(queue.pendingCount()).toBe(0);
    });

    it("runs an enqueued note after its debounce elapses without an explicit flush", async () => {
      const runner = jest.fn<Promise<ImageAutoIndexRunResult>, [string, number]>(
        async () => "described"
      );
      const queue = createImageAutoIndexQueue({ describeNoteImages: runner });

      queue.enqueueNote("note.md");
      expect(runner).not.toHaveBeenCalled();
      expect(queue.pendingCount()).toBe(1);

      jest.advanceTimersByTime(3000);
      await settle();

      expect(runner).toHaveBeenCalledTimes(1);
      expect(runner).toHaveBeenCalledWith("note.md", 20);
    });

    it("does not queue a running note but re-runs it after the run when it was re-enqueued mid-run", async () => {
      const resolvers: Array<(result: ImageAutoIndexRunResult) => void> = [];
      const runner = jest.fn<Promise<ImageAutoIndexRunResult>, [string, number]>(
        () =>
          new Promise<ImageAutoIndexRunResult>((resolve) => {
            resolvers.push(resolve);
          })
      );
      const queue = createImageAutoIndexQueue({
        describeNoteImages: runner,
        debounceMs: 0,
      });

      queue.enqueueNote("note.md");
      const drained = queue.flush();
      expect(runner).toHaveBeenCalledTimes(1);

      queue.enqueueNote("note.md");
      expect(queue.pendingCount()).toBe(0);

      resolvers[0]("described");
      await settle();

      expect(runner).toHaveBeenCalledTimes(2);
      expect(queue.pendingCount()).toBe(0);

      resolvers[1]("described");
      await drained;
    });

    it("reports a thrown runner failure through onError and keeps draining the rest", async () => {
      const onError = jest.fn();
      const runner = jest.fn<Promise<ImageAutoIndexRunResult>, [string, number]>(
        async (notePath: string) => {
          if (notePath === "b.md") throw new Error("model outage");
          return "described";
        }
      );
      const queue = createImageAutoIndexQueue({
        describeNoteImages: runner,
        onError,
        maxConcurrent: 1,
        debounceMs: 0,
      });

      queue.enqueueNote("a.md");
      queue.enqueueNote("b.md");
      queue.enqueueNote("c.md");
      await queue.flush();

      expect(runner).toHaveBeenCalledTimes(3);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
      expect(onError.mock.calls[0][1]).toBe("b.md");
    });

    it("caps queued paths at the configured bound and evicts the oldest on overflow", async () => {
      const runner = jest.fn<Promise<ImageAutoIndexRunResult>, [string, number]>(
        async (_notePath: string, _maxImages: number) => "described"
      );
      const queue = createImageAutoIndexQueue({
        describeNoteImages: runner,
        maxConcurrent: IMAGE_AUTO_INDEX_MAX_QUEUED_NOTE_PATHS,
        debounceMs: 3000,
      });

      const paths = Array.from(
        { length: IMAGE_AUTO_INDEX_MAX_QUEUED_NOTE_PATHS + 5 },
        (_, index) => `note-${index}.md`
      );
      for (const path of paths) queue.enqueueNote(path);

      expect(queue.pendingCount()).toBe(IMAGE_AUTO_INDEX_MAX_QUEUED_NOTE_PATHS);

      jest.advanceTimersByTime(3000);
      await settle();

      expect(runner).toHaveBeenCalledTimes(IMAGE_AUTO_INDEX_MAX_QUEUED_NOTE_PATHS);
      expect(runner.mock.calls.map((call) => call[0])).toEqual(paths.slice(5));
    });

    it("forwards the configured per-note image cap to the runner", async () => {
      const runner = jest.fn<Promise<ImageAutoIndexRunResult>, [string, number]>(
        async () => "described"
      );
      const queue = createImageAutoIndexQueue({
        describeNoteImages: runner,
        maxPerNote: 7,
        debounceMs: 0,
      });

      queue.enqueueNote("note.md");
      await queue.flush();

      expect(runner).toHaveBeenCalledWith("note.md", 7);
    });

    it("drops pending work and timers on stop() and ignores later enqueues", async () => {
      const runner = jest.fn<Promise<ImageAutoIndexRunResult>, [string, number]>(
        async () => "described"
      );
      const queue = createImageAutoIndexQueue({ describeNoteImages: runner });

      queue.enqueueNote("note.md");
      queue.stop();
      expect(queue.pendingCount()).toBe(0);

      queue.enqueueNote("note.md");
      jest.advanceTimersByTime(10000);
      await settle();
      await queue.flush();

      expect(runner).not.toHaveBeenCalled();
    });
  });
});
