import { beforeAll, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { taskRuns } from "@/lib/db/schema";
import type { TimeProvider } from "@/lib/time-provider";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { InMemoryObjectStore } from "@/artifacts/infra/in-memory-object-store";
import { taskLogArchiveKey } from "@/tasks/task-log/application/finalize-task-log";
import { DrizzleLogFeedStore } from "@/tasks/task-log/infra/drizzle-log-feed-store";
import { purgeAbandonedTaskLogs } from "@/tasks/task-log/application/purge-abandoned-task-logs";
import {
  fixedTimeProvider,
  serialTest,
  unwrapAsync,
  unwrapStartedTaskAsync,
} from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

const buildStepDefinitionPayload = (projectId: UuidV7, key: string) => ({
  projectId,
  key,
  name: "Loggable step",
  description: "Reusable step for abandoned-log cleanup tests",
  prompt: "Return a result payload.",
  version: 1,
  kind: "user_defined" as const,
  inputSchemaJson: { type: "object" },
  resultSchemaJson: { type: "object" },
  status: "active" as const,
});

const claimStep = async (
  apiClient: ReturnType<typeof createScarnTreaty>,
  authHeaders: { authorization: string },
  projectId: UuidV7,
  stepDefinitionId: UuidV7,
  workerId: string,
): Promise<{ taskRunId: UuidV7; claimToken: string }> => {
  const { run: task } = await unwrapStartedTaskAsync(
    apiClient.api.tasks.post(
      {
        projectId,
        workItemId: await seedWorkItem(projectId),
        stepDefinitionId,
        stepDefinitionVersion: 1,
        inputJson: { ticketId: `ticket-${workerId}` },
        executionTimeoutSeconds: 300,
      },
      { headers: { ...authHeaders } },
    ),
  );
  const claims = await unwrapAsync(
    apiClient.api["task-runs"].claims.post(
      {
        projectId,
        workerId,
        batchSize: 1,
        leaseDurationSeconds: 30,
      },
      { headers: { ...authHeaders } },
    ),
  );
  const claimToken = claims[0]?.claimToken;
  if (!claimToken) {
    throw new Error("Expected claim token to be returned");
  }
  return { taskRunId: task.id, claimToken };
};

/**
 * Cleanup of the live log feed for task runs that reach the terminal
 * `abandoned` status. Abandoned steps never run the completion path, so their
 * hot rows would leak; they are dropped from Postgres (never archived to S3) by
 * the scheduled sweeper.
 *
 * Phase 2 note: liveness is now derived on the entity, so reads NEVER write —
 * a lease-expired step reports `abandoned` on read but its status is not
 * persisted and its feed is not purged on that read. The scheduled sweeper is
 * the sole collector.
 *
 * Phase 4 note: the sweeper no longer keys on a persisted `abandoned` status.
 * It reproduces the entity's expiry rule in SQL, so a plain `running` step whose
 * `lease_expires_at` (or `execution_deadline_at`) lapsed past the grace window
 * is collected WITHOUT any status write. The legacy arm — rows still persisted
 * as `abandoned` from before Phase 2 — remains, gated on `completed_at`. Both
 * are exercised below.
 */
describe("task abandoned-log cleanup", () => {
  let currentTime = new Date("2026-05-01T13:00:00.000Z");
  const timeProvider: TimeProvider = {
    now: () => currentTime,
    nowIso: () => currentTime.toISOString(),
  };
  const objectStore = new InMemoryObjectStore();
  const app = createApp(createAppContext({ timeProvider, objectStore }));
  const apiClient = createScarnTreaty(app);
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;
  let stepDefinitionId: UuidV7 | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `abandoned-logs-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Abandoned Logs Project",
          description: "Project for abandoned-log cleanup tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        buildStepDefinitionPayload(
          parseUuidV7(project.id),
          `abandoned_log_step_${crypto.randomUUID()}`,
        ),
        { headers: { ...owner.authHeaders } },
      ),
    );
    stepDefinitionId = stepDefinition.id;
  });

  serialTest(
    "derives abandoned on read without persisting status, purging the feed, or archiving",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId) {
        throw new Error("Expected setup to complete");
      }
      currentTime = new Date("2026-05-01T13:00:00.000Z");
      const { taskRunId, claimToken } = await claimStep(
        apiClient,
        authHeaders,
        parseUuidV7(project.id),
        stepDefinitionId,
        "worker-abandon-lazy",
      );

      await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: taskRunId }).logs.post(
          {
            claimToken,
            lines: [
              {
                seq: 1,
                stream: "worker",
                ts: "2026-05-01T13:00:01.000Z",
                content: "abandoned work",
                level: "info",
              },
            ],
          },
          { headers: { ...authHeaders } },
        ),
      );

      // Advance past the 30s lease so the next load derives abandoned.
      currentTime = new Date("2026-05-01T13:00:31.000Z");
      const abandoned = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: taskRunId }).get({
          headers: { ...authHeaders },
        }),
      );
      expect(abandoned.status).toBe("abandoned");

      // Reads never write (Phase 2): the derived `abandoned` status is NOT
      // persisted, so the raw column still reads `running`, and the hot feed is
      // NOT purged by the read. The scheduled sweeper is the only collector; its
      // coverage lives in the sweeper test below (and is rebased onto derived
      // expiry in Phase 4).
      const [persisted] = await getDb()
        .select({ status: taskRuns.status })
        .from(taskRuns)
        .where(eq(taskRuns.id, taskRunId));
      expect(persisted?.status).toBe("running");

      const afterAbandon = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: taskRunId }).logs.get({
          query: { from: 0, limit: 1000 },
          headers: { ...authHeaders },
        }),
      );
      expect(afterAbandon.lines).toHaveLength(1);

      // No archive was written — abandoned steps never run the completion path,
      // so their logs are never flushed to S3.
      const archived = await objectStore.getObject(
        taskLogArchiveKey(taskRunId),
      );
      expect(archived).toBeNull();
    },
  );

  serialTest(
    "sweeper purges feeds for a lapsed-lease running step without writing status",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId) {
        throw new Error("Expected setup to complete");
      }
      // Claim at 14:00:00 with a 30s lease -> lease_expires_at = 14:00:30. The
      // status column stays `running`: nothing persists `abandoned` anymore.
      currentTime = new Date("2026-05-01T14:00:00.000Z");
      const { taskRunId } = await claimStep(
        apiClient,
        authHeaders,
        parseUuidV7(project.id),
        stepDefinitionId,
        "worker-abandon-derived",
      );

      // Seed the hot feed for the (now derived-abandoned) step.
      const feed = new DrizzleLogFeedStore();
      await feed.append(taskRunId, [
        {
          seq: 1,
          stream: "worker",
          ts: "2026-05-01T14:00:02.000Z",
          content: "orphaned line",
          level: "info",
        },
      ]);
      expect(await feed.readAll(taskRunId)).not.toEqual([]);

      // The step is a plain `running` row — abandonment is DERIVED, never
      // written. Confirm the sweeper still finds it via the expiry clock.
      const [beforeSweep] = await getDb()
        .select({ status: taskRuns.status })
        .from(taskRuns)
        .where(eq(taskRuns.id, taskRunId));
      expect(beforeSweep?.status).toBe("running");

      // Within the grace window (cutoff 13:58:00 < lease expiry 14:00:30):
      // sweeper must NOT touch THIS step yet — a late worker flush must not be
      // raced. (We assert on this step's feed rather than the global purge
      // count, because sibling integration files share the test DB and may leave
      // their own lapsed-lease steps that the sweep legitimately collects.)
      await purgeAbandonedTaskLogs({
        logFeedStore: feed,
        timeProvider: fixedTimeProvider(new Date("2026-05-01T14:03:00.000Z")),
      });
      expect(await feed.readAll(taskRunId)).not.toEqual([]);

      // Past the grace window (cutoff 14:05:00 > lease expiry 14:00:30): the
      // orphaned rows are dropped.
      const swept = await purgeAbandonedTaskLogs({
        logFeedStore: feed,
        timeProvider: fixedTimeProvider(new Date("2026-05-01T14:10:00.000Z")),
      });
      expect(swept.stepsPurged).toBeGreaterThanOrEqual(1);
      expect(await feed.readAll(taskRunId)).toEqual([]);

      // The purge is a maintenance sweep over rows: it must NEVER write status.
      const [afterSweep] = await getDb()
        .select({ status: taskRuns.status })
        .from(taskRuns)
        .where(eq(taskRuns.id, taskRunId));
      expect(afterSweep?.status).toBe("running");
    },
  );

  serialTest(
    "sweeper still collects legacy persisted-abandoned rows past the grace window",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId) {
        throw new Error("Expected setup to complete");
      }
      currentTime = new Date("2026-05-01T15:00:00.000Z");
      const { taskRunId } = await claimStep(
        apiClient,
        authHeaders,
        parseUuidV7(project.id),
        stepDefinitionId,
        "worker-abandon-legacy",
      );

      // Legacy backlog row: persisted as `abandoned` before Phase 2 with the
      // lease nulled (`clearClaim`), so derivation cannot see it — only its
      // `completed_at` remains. The sweeper's legacy arm gates on that column.
      await getDb()
        .update(taskRuns)
        .set({
          status: "abandoned",
          completedAt: new Date("2026-05-01T15:00:31.000Z"),
          claimedBy: null,
          claimToken: null,
          leaseExpiresAt: null,
        })
        .where(eq(taskRuns.id, taskRunId));

      const feed = new DrizzleLogFeedStore();
      await feed.append(taskRunId, [
        {
          seq: 1,
          stream: "worker",
          ts: "2026-05-01T15:00:02.000Z",
          content: "legacy orphaned line",
          level: "info",
        },
      ]);
      expect(await feed.readAll(taskRunId)).not.toEqual([]);

      // Within the grace window: legacy row untouched. At 15:02:00 the cutoff is
      // 14:57:00, which is before completed_at 15:00:31, so the legacy arm does
      // not match yet. (Asserting on this step's feed, not the global count —
      // sibling files share the DB.)
      await purgeAbandonedTaskLogs({
        logFeedStore: feed,
        timeProvider: fixedTimeProvider(new Date("2026-05-01T15:02:00.000Z")),
      });
      expect(await feed.readAll(taskRunId)).not.toEqual([]);

      // Past the grace window: legacy row still collected.
      const swept = await purgeAbandonedTaskLogs({
        logFeedStore: feed,
        timeProvider: fixedTimeProvider(new Date("2026-05-01T15:10:00.000Z")),
      });
      expect(swept.stepsPurged).toBeGreaterThanOrEqual(1);
      expect(await feed.readAll(taskRunId)).toEqual([]);

      // Idempotent: a second run finds nothing to purge for this step.
      await feed.append(taskRunId, []);
      await purgeAbandonedTaskLogs({
        logFeedStore: feed,
        timeProvider: fixedTimeProvider(new Date("2026-05-01T15:11:00.000Z")),
      });
      expect(await feed.readAll(taskRunId)).toEqual([]);
    },
  );
});
