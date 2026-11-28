import { beforeAll, describe, expect } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import type { ObjectStore } from "@/artifacts/object-store";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { reconcileStorageUsage } from "@/billing/usage-meter/application/reconcile-storage-usage";
import { currentBillingPeriod } from "@/billing/usage-meter/domain/billing-period";
import { UsageMeter } from "@/billing/usage-meter/domain/usage-meter-entity";
import { PLAN_LIMITS_CONFIG } from "@/billing/plan/domain/plan-limits";
import { getDb } from "@/lib/db";
import { taskRuns } from "@/lib/db/schema";
import { serialTest, unwrapAsync } from "tests/utils";
import type { Claim } from "./integration/pipeline-run-test-support";
import { createQuestionHarness } from "./integration/question-test-support";

/** Presigns deterministic URLs, records deleted keys and fails the keys in `failing`. */
const trackingObjectStore = () => {
  const deletedKeys: string[] = [];
  const failing = new Set<string>();
  const store: ObjectStore = {
    putObject: () => Promise.resolve({ sizeBytes: 0 }),
    getObject: () => Promise.resolve(null),
    getObjectStream: () => Promise.resolve(null),
    getPresignedGetUrl: (key: string) =>
      Promise.resolve(`https://store.test/get/${key}`),
    getPresignedPutUrl: (key: string) =>
      Promise.resolve(`https://store.test/put/${key}`),
    deleteObject: (key: string) => {
      if (failing.has(key)) {
        return Promise.reject(new Error("object store unavailable"));
      }
      deletedKeys.push(key);
      return Promise.resolve();
    },
    deletePrefix: () => Promise.resolve({ deletedCount: 0 }),
  };
  return { store, deletedKeys, failing };
};

/** A harness over a fresh org, and the calls these tests make. */
const createSessionHarness = (name: string) => {
  const objectStore = trackingObjectStore();
  const { harness, headers } = createQuestionHarness(name, {
    objectStore: objectStore.store,
  });
  harness.setTime(new Date().toISOString());
  const { appContext } = harness;

  const document = (): PipelineDocument => ({
    schemaVersion: 1,
    key: harness.uniqueKey("session-metering"),
    start: { to: "evaluate" },
    nodes: {
      evaluate: {
        kind: "step",
        step: harness.requireSetup().stepKey,
        next: { routes: [{ to: "done" }] },
      },
      done: { kind: "succeed" },
    },
  });

  const orgId = async () => {
    const org = await appContext.orgRepo.findByProjectId(
      harness.requireSetup().projectId,
    );
    if (!org) {
      throw new Error("Expected the project to have an org");
    }
    return org.id;
  };

  const meter = async () =>
    await appContext.usageMeterRepo.loadOrStart(
      await orgId(),
      currentBillingPeriod(appContext.timeProvider.now()),
      "free",
    );

  const uploadSession = async (claimed: Claim, sizeBytes: number) =>
    await unwrapAsync(
      harness.apiClient.api["task-runs"]({ taskRunId: claimed.taskId })[
        "session-upload-url"
      ].post(
        { claimToken: claimed.claimToken, sizeBytes },
        { headers: headers() },
      ),
    );

  const yieldTask = (
    claimed: Claim,
    session: { objectKey: string; sizeBytes: number } | null,
  ) =>
    harness.apiClient.api["task-runs"]({
      taskRunId: claimed.taskId,
    }).yields.post(
      {
        claimToken: claimed.claimToken,
        message: "Should the fix target v1 or v2?",
        workBranch: "scarn/evaluate-1",
        createdFromBranch: "main",
        sessionObjectKey: session?.objectKey ?? null,
        sessionSizeBytes: session?.sizeBytes ?? null,
        sessionRestored: null,
      },
      { headers: headers() },
    );

  /** Yields `claimed`, saving a session of `sizeBytes` when it is not null. */
  const yieldWithSession = async (claimed: Claim, sizeBytes: number | null) => {
    const session =
      sizeBytes === null
        ? null
        : {
            objectKey: (await uploadSession(claimed, sizeBytes)).objectKey,
            sizeBytes,
          };
    await unwrapAsync(yieldTask(claimed, session));
  };

  const conversationIdOf = async (executionId: UuidV7) => {
    const { conversationId } = harness.visitOf(
      await harness.getRun(executionId),
      "evaluate",
    );
    if (!conversationId) {
      throw new Error("Expected a conversation");
    }
    return conversationId;
  };

  const reply = async (executionId: UuidV7, body: string) =>
    await unwrapAsync(
      harness.apiClient.api
        .conversations({ conversationId: await conversationIdOf(executionId) })
        .messages.post({ body }, { headers: headers() }),
    );

  const restoreOf = async (claimed: Claim) =>
    (
      await unwrapAsync(
        harness.apiClient.api["task-runs"]({ taskRunId: claimed.taskId })[
          "worker-context"
        ].post({ claimToken: claimed.claimToken }, { headers: headers() }),
      )
    ).restoreSession;

  const sessionColumns = async (runIds: UuidV7[]) =>
    await getDb()
      .select({
        id: taskRuns.id,
        key: taskRuns.sessionObjectKey,
        size: taskRuns.sessionSizeBytes,
      })
      .from(taskRuns)
      .where(inArray(taskRuns.id, runIds));

  const sessionColumnsOf = async (runId: UuidV7) =>
    (
      await getDb()
        .select({
          key: taskRuns.sessionObjectKey,
          size: taskRuns.sessionSizeBytes,
        })
        .from(taskRuns)
        .where(eq(taskRuns.id, runId))
    )[0];

  const startClaimed = async () => {
    const started = await harness.startRun(document());
    const workItemId = parseUuidV7(started.workItemId);
    return {
      executionId: started.executionId,
      workItemId,
      claimed: await harness.claimOne(workItemId),
    };
  };

  /** Reconciles this harness's org only, leaving every other file's rows alone. */
  const reconcile = async () =>
    await reconcileStorageUsage({
      usageMeterRepo: appContext.usageMeterRepo,
      storageUsageReader: appContext.storageUsageReader,
      taskRunRepo: appContext.taskRunRepo,
      artifactRepo: appContext.artifactRepo,
      artifactFailureRepo: appContext.artifactFailureRepo,
      timeProvider: appContext.timeProvider,
      orgId: await orgId(),
    });

  return {
    harness,
    objectStore,
    orgId,
    meter,
    uploadSession,
    yieldTask,
    yieldWithSession,
    reply,
    restoreOf,
    sessionColumns,
    sessionColumnsOf,
    startClaimed,
    reconcile,
  };
};

const sessionKeyOf = (runId: UuidV7) => `tasks/${runId}/session.json`;

describe("session metering: a yield's saved session is stored with its size and metered", () => {
  const sessions = createSessionHarness("session-metering");

  beforeAll(async () => {
    await sessions.harness.setUp();
  });

  serialTest(
    "a yield with a session stores its size and adds one write plus its bytes; without one it adds neither",
    async () => {
      const withoutSession = await sessions.startClaimed();
      const beforeWithout = await sessions.meter();
      await sessions.yieldWithSession(withoutSession.claimed, null);
      const afterWithout = await sessions.meter();
      expect(afterWithout.storageBytes).toBe(beforeWithout.storageBytes);
      expect(
        await sessions.sessionColumnsOf(withoutSession.claimed.taskId),
      ).toEqual({ key: null, size: null });

      const withSession = await sessions.startClaimed();
      const beforeWith = await sessions.meter();
      await sessions.yieldWithSession(withSession.claimed, 1500);
      const afterWith = await sessions.meter();

      expect(
        await sessions.sessionColumnsOf(withSession.claimed.taskId),
      ).toEqual({ key: sessionKeyOf(withSession.claimed.taskId), size: 1500 });
      expect(afterWith.storageBytes - beforeWith.storageBytes).toBe(1500);
      expect(afterWith.writes - beforeWith.writes).toBe(
        afterWithout.writes - beforeWithout.writes + 1,
      );
    },
    30_000,
  );

  serialTest(
    "latest-only: a later yield keeps only its own session, and a continuation restores the previous run's",
    async () => {
      const {
        executionId,
        workItemId,
        claimed: first,
      } = await sessions.startClaimed();
      await sessions.yieldWithSession(first, 100);
      await sessions.reply(executionId, "Target v2.");
      const second = await sessions.harness.claimOne(workItemId);
      expect((await sessions.restoreOf(second))?.downloadUrl).toBe(
        `https://store.test/get/${sessionKeyOf(first.taskId)}`,
      );

      const before = await sessions.meter();
      await sessions.yieldWithSession(second, 300);
      const after = await sessions.meter();

      expect(after.storageBytes - before.storageBytes).toBe(300 - 100);
      const columns = await sessions.sessionColumns([
        first.taskId,
        second.taskId,
      ]);
      expect(columns).toContainEqual({
        id: first.taskId,
        key: null,
        size: null,
      });
      expect(columns).toContainEqual({
        id: second.taskId,
        key: sessionKeyOf(second.taskId),
        size: 300,
      });
      expect(sessions.objectStore.deletedKeys).toContain(
        sessionKeyOf(first.taskId),
      );
      expect(sessions.objectStore.deletedKeys).not.toContain(
        sessionKeyOf(second.taskId),
      );

      await sessions.reply(executionId, "Keep the old flag.");
      const third = await sessions.harness.claimOne(workItemId);
      expect((await sessions.restoreOf(third))?.downloadUrl).toBe(
        `https://store.test/get/${sessionKeyOf(second.taskId)}`,
      );
    },
    30_000,
  );

  serialTest(
    "a failed delete of the superseded session doesn't fail the yield",
    async () => {
      const {
        executionId,
        workItemId,
        claimed: first,
      } = await sessions.startClaimed();
      await sessions.yieldWithSession(first, 100);
      sessions.objectStore.failing.add(sessionKeyOf(first.taskId));
      await sessions.reply(executionId, "Target v2.");
      const second = await sessions.harness.claimOne(workItemId);

      await sessions.yieldWithSession(second, 200);

      expect((await sessions.harness.getTaskRun(second.taskId)).status).toBe(
        "yielded",
      );
      expect(await sessions.sessionColumnsOf(first.taskId)).toEqual({
        key: null,
        size: null,
      });
    },
    30_000,
  );

  serialTest(
    "the Task ending clears its runs' session columns and takes their bytes off the meter",
    async () => {
      const {
        executionId,
        workItemId,
        claimed: first,
      } = await sessions.startClaimed();
      await sessions.yieldWithSession(first, 400);
      await sessions.reply(executionId, "Target v2.");
      const second = await sessions.harness.claimOne(workItemId);
      const before = await sessions.meter();

      await sessions.harness.complete(second, "succeeded");

      expect((await sessions.harness.getRun(executionId)).runStatus).toBe(
        "succeeded",
      );
      expect(await sessions.sessionColumnsOf(first.taskId)).toEqual({
        key: null,
        size: null,
      });
      expect(before.storageBytes - (await sessions.meter()).storageBytes).toBe(
        400,
      );
      expect(sessions.objectStore.deletedKeys).toContain(
        sessionKeyOf(first.taskId),
      );
    },
    30_000,
  );
});

describe("session metering over the storage cap", () => {
  const sessions = createSessionHarness("session-metering-cap");

  beforeAll(async () => {
    await sessions.harness.setUp();
  });

  serialTest(
    "a yield over the cap still succeeds and records the write without the bytes, and the next reconciliation counts them",
    async () => {
      const { claimed } = await sessions.startClaimed();
      const upload = await sessions.uploadSession(claimed, 2048);
      const nearCap = PLAN_LIMITS_CONFIG.free.maxStorageBytes - 10;
      const current = await sessions.meter();
      await sessions.harness.appContext.usageMeterRepo.save(
        UsageMeter.rehydrate({ ...current.toJSON(), storageBytes: nearCap }),
      );
      const before = await sessions.meter();

      await unwrapAsync(
        sessions.yieldTask(claimed, {
          objectKey: upload.objectKey,
          sizeBytes: 2048,
        }),
      );
      const after = await sessions.meter();

      expect(after.storageBytes).toBe(nearCap);
      expect(after.writes).toBeGreaterThan(before.writes);
      expect(await sessions.sessionColumnsOf(claimed.taskId)).toEqual({
        key: sessionKeyOf(claimed.taskId),
        size: 2048,
      });

      await sessions.reconcile();
      const breakdown =
        await sessions.harness.appContext.storageUsageReader.getRetainedBytesBreakdownForOrg(
          await sessions.orgId(),
          sessions.harness.appContext.timeProvider.now(),
          30,
        );
      expect(breakdown.sessionBytes).toBe(2048);
      expect((await sessions.meter()).storageBytes).toBe(
        breakdown.artifactBytes + breakdown.logBytes + breakdown.sessionBytes,
      );
    },
    30_000,
  );
});
