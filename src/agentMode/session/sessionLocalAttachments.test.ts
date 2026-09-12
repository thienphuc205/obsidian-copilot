import {
  CHAT_ATTACHMENT_REF_SCHEMA_VERSION,
  MAX_CHAT_ATTACHMENT_REFS,
} from "@/agentMode/session/chatAttachmentRefs";
import {
  createSessionLocalAttachmentStaging,
  type SessionLocalAttachmentTarget,
} from "./sessionLocalAttachments";

describe("sessionLocalAttachments", () => {
  function target(overrides: Partial<SessionLocalAttachmentTarget> = {}) {
    return {
      sessionId: "session-1",
      projectId: "project-1",
      vaultId: "vault-1",
      ...overrides,
    } satisfies SessionLocalAttachmentTarget;
  }

  function ref(attachmentId: string, vaultId = "vault-1") {
    return {
      schemaVersion: CHAT_ATTACHMENT_REF_SCHEMA_VERSION,
      vaultId,
      attachmentId,
    };
  }

  function makeStaging(
    initialTarget = target(),
    getLiveTarget: () =>
      | SessionLocalAttachmentTarget
      | null
      | Promise<SessionLocalAttachmentTarget | null> = () => initialTarget
  ) {
    return createSessionLocalAttachmentStaging({
      target: initialTarget,
      getLiveTarget,
    });
  }

  describe("createSessionLocalAttachmentStaging()", () => {
    it("stages immutable deduplicated refs without changing the caller input", async () => {
      const staging = makeStaging();
      const input = [ref("a"), ref("a"), ref("b")];

      const snapshot = await staging.stage({ target: target(), refs: input });

      expect(input).toEqual([ref("a"), ref("a"), ref("b")]);
      expect(snapshot.refs.map((item) => item.attachmentId)).toEqual(["a", "b"]);
      expect(staging.getSnapshot()).toBe(snapshot);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.target)).toBe(true);
      expect(Object.isFrozen(snapshot.refs)).toBe(true);
      expect(Object.isFrozen(snapshot.refs[0])).toBe(true);
      await expect(staging.stage({ target: target(), refs: [ref("a")] })).resolves.toBe(snapshot);
    });

    it("rejects malformed and cross-vault batches as a whole", async () => {
      const staging = makeStaging();
      await staging.stage({ target: target(), refs: [ref("seed")] });

      await expect(
        staging.stage({
          target: target(),
          refs: [ref("kept"), { schemaVersion: CHAT_ATTACHMENT_REF_SCHEMA_VERSION }],
        })
      ).rejects.toMatchObject({ code: "invalid-refs" });
      await expect(
        staging.stage({ target: target(), refs: [ref("kept"), ref("foreign", "vault-2")] })
      ).rejects.toMatchObject({ code: "foreign-vault" });

      expect(staging.getSnapshot().refs.map((item) => item.attachmentId)).toEqual(["seed"]);
    });

    it("rejects an over-budget batch or combined result without partial state", async () => {
      const staging = makeStaging();
      const firstBatch = Array.from({ length: MAX_CHAT_ATTACHMENT_REFS }, (_, index) =>
        ref(`first-${index}`)
      );
      await staging.stage({ target: target(), refs: firstBatch });

      await expect(
        staging.stage({ target: target(), refs: [...firstBatch, ref("raw-over-budget")] })
      ).rejects.toMatchObject({ code: "ref-limit" });
      await expect(
        staging.stage({ target: target(), refs: [ref("combined-over-budget")] })
      ).rejects.toMatchObject({ code: "ref-limit" });

      expect(staging.getSnapshot().refs).toHaveLength(MAX_CHAT_ATTACHMENT_REFS);
      expect(staging.getSnapshot().refs[0].attachmentId).toBe("first-0");
    });

    it("checks session, project, and vault identity on every mutation", async () => {
      const staging = makeStaging();
      const mismatchedTargets = [
        target({ sessionId: "session-2" }),
        target({ projectId: "project-2" }),
        target({ vaultId: "vault-2" }),
      ];

      for (const mismatchedTarget of mismatchedTargets) {
        await expect(
          staging.stage({ target: mismatchedTarget, refs: [ref("rejected")] })
        ).rejects.toMatchObject({ code: "stale-target" });
        await expect(staging.clear(mismatchedTarget)).rejects.toMatchObject({
          code: "stale-target",
        });
      }
      await staging.stage({ target: target(), refs: [ref("kept")] });
      await expect(
        staging.remove({ target: target({ projectId: "project-2" }), attachmentId: "kept" })
      ).rejects.toMatchObject({ code: "stale-target" });
      expect(staging.getSnapshot().refs.map((item) => item.attachmentId)).toEqual(["kept"]);
    });

    it("fails closed when the live target is stale, absent, or throws", async () => {
      let liveTarget: SessionLocalAttachmentTarget | null = target({ sessionId: "other-session" });
      const staging = makeStaging(target(), () => liveTarget);

      await expect(staging.stage({ target: target(), refs: [ref("stale")] })).rejects.toMatchObject(
        {
          code: "stale-target",
        }
      );
      liveTarget = null;
      await expect(staging.clear(target())).rejects.toMatchObject({ code: "stale-target" });
      staging.updateLiveTargetGetter(() => {
        throw new Error("host lookup failed");
      });
      await expect(
        staging.remove({ target: target(), attachmentId: "missing" })
      ).rejects.toMatchObject({
        code: "stale-target",
      });
      expect(staging.getSnapshot().refs).toHaveLength(0);
    });

    it("refreshes the live lookup without rebinding or clearing the bucket", async () => {
      const oldGetter = jest.fn(() => target());
      const newGetter = jest.fn(() => target());
      const staging = makeStaging(target(), oldGetter);
      await staging.stage({ target: target(), refs: [ref("before-refresh")] });

      staging.updateLiveTargetGetter(newGetter);
      await staging.stage({ target: target(), refs: [ref("after-refresh")] });

      expect(oldGetter).toHaveBeenCalledTimes(1);
      expect(newGetter).toHaveBeenCalledTimes(1);
      expect(staging.getSnapshot().refs.map((item) => item.attachmentId)).toEqual([
        "before-refresh",
        "after-refresh",
      ]);
    });

    it("rejects approval from an old getter after a refreshed authority is installed", async () => {
      let resolveOldGetter: ((value: SessionLocalAttachmentTarget) => void) | null = null;
      const oldGetter = jest.fn(
        () =>
          new Promise<SessionLocalAttachmentTarget>((resolve) => {
            resolveOldGetter = resolve;
          })
      );
      const newGetter = jest.fn(() => target());
      const staging = makeStaging(target(), oldGetter);
      const pending = staging.stage({ target: target(), refs: [ref("stale-approval")] });
      await Promise.resolve();
      await Promise.resolve();
      expect(oldGetter).toHaveBeenCalledTimes(1);

      staging.updateLiveTargetGetter(newGetter);
      resolveOldGetter!(target());
      await expect(pending).rejects.toMatchObject({ code: "stale-target" });
      expect(staging.getSnapshot().refs).toHaveLength(0);

      await expect(
        staging.stage({ target: target(), refs: [ref("new-authority")] })
      ).resolves.toMatchObject({ refs: [ref("new-authority")] });
      expect(newGetter).toHaveBeenCalledTimes(1);
    });

    it("removes one fixed-vault ref, clears the remainder, and preserves snapshots", async () => {
      const staging = makeStaging();
      await staging.stage({ target: target(), refs: [ref("a"), ref("b")] });

      const afterRemove = await staging.remove({ target: target(), attachmentId: "a" });
      expect(afterRemove.refs.map((item) => item.attachmentId)).toEqual(["b"]);
      await expect(staging.remove({ target: target(), attachmentId: "missing" })).resolves.toBe(
        afterRemove
      );
      const afterClear = await staging.clear(target());
      expect(afterClear.refs).toHaveLength(0);
      expect(staging.getSnapshot()).toBe(afterClear);
    });

    it("serializes concurrent mutations so the ref limit cannot be exceeded", async () => {
      const staging = makeStaging();
      const first = Array.from({ length: 9 }, (_, index) => ref(`first-${index}`));
      const second = Array.from({ length: 9 }, (_, index) => ref(`second-${index}`));

      const results = await Promise.allSettled([
        staging.stage({ target: target(), refs: first }),
        staging.stage({ target: target(), refs: second }),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(staging.getSnapshot().refs).toHaveLength(9);
    });

    it("denies a mutation waiting on live state when disposed and clears volatile refs", async () => {
      let resolveLive: ((value: SessionLocalAttachmentTarget) => void) | null = null;
      const getLiveTarget = jest.fn(
        () =>
          new Promise<SessionLocalAttachmentTarget>((resolve) => {
            resolveLive = resolve;
          })
      );
      const staging = makeStaging(target(), getLiveTarget);
      const pending = staging.stage({ target: target(), refs: [ref("late")] });
      await Promise.resolve();
      await Promise.resolve();
      expect(getLiveTarget).toHaveBeenCalledTimes(1);

      staging.dispose();
      await expect(pending).rejects.toMatchObject({ code: "disposed" });
      expect(staging.getSnapshot().refs).toHaveLength(0);
      await expect(staging.clear(target())).rejects.toMatchObject({ code: "disposed" });

      resolveLive!(target());
      await Promise.resolve();
      expect(staging.getSnapshot().refs).toHaveLength(0);
    });

    it("does not require any blob, network, backend, history, or prompt dependency", async () => {
      const liveLookup = jest.fn(() => target());
      const staging = makeStaging(target(), liveLookup);

      await staging.stage({ target: target(), refs: [ref("metadata-only")] });
      expect(liveLookup).toHaveBeenCalledTimes(1);
      expect(staging.getSnapshot().refs).toEqual([ref("metadata-only")]);
    });
  });
});
