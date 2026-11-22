import { eq } from "drizzle-orm";
import { describe, expect, test } from "bun:test";
import { getDb } from "@/lib/db";
import { projects, taskArtifactFailures, taskRuns } from "@/lib/db/schema";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { DrizzleArtifactFailureRepo } from "@/tasks/task-artifact/infra/drizzle-artifact-failure-repo";
import {
  seedTaskRunParent,
  seedTaskPrerequisites,
} from "tests/lib/db/seed-task-prerequisites";

/**
 * Integration coverage for `DrizzleArtifactFailureRepo`, mirroring
 * `drizzle-artifact-repo.test.ts` 1:1 for the sibling failure-tracking repo:
 * `record`, `listByTask` (newest first, per the
 * `(taskRunId, createdAt desc)` index), and `deleteExpiredFailures`
 * (hard delete — unlike `clearExpiredArtifacts`, a failure row carries no
 * bytes to null out, so expiry removes the row outright).
 *
 * Rows are seeded directly via Drizzle (project -> work item + capability
 * profile -> task -> [artifact failure]), the same FK chain the API itself writes.
 */
describe("DrizzleArtifactFailureRepo", () => {
  const repo = new DrizzleArtifactFailureRepo();

  /** Seeds a project -> Task prerequisites -> task chain. */
  const seedTask = async (): Promise<{
    projectId: UuidV7;
    taskRunId: UuidV7;
  }> => {
    const db = getDb();
    const projectId = createUuidV7();
    const taskRunId = createUuidV7();

    await db.insert(projects).values({
      id: projectId,
      name: "Artifact failure repo test project",
      slug: `artifact-failure-repo-${crypto.randomUUID()}`,
      gitUrl: "https://github.com/example/test-project.git",
      createdByUserId: createUuidV7(),
      orgId: createUuidV7(),
    });

    const { workItemId } = await seedTaskPrerequisites(projectId, db);

    await db.insert(taskRuns).values({
      id: taskRunId,
      projectId,
      workItemId,
      ...(await seedTaskRunParent({ projectId, workItemId }, db)),
      status: "succeeded",
    });

    return { projectId, taskRunId };
  };

  /** Seeds a failure row directly via Drizzle, bypassing `repo.record`. */
  const seedFailure = async (opts: {
    taskRunId: UuidV7;
    projectId: UuidV7;
    createdAt: Date;
    relativeStorePath?: string;
  }): Promise<{ failureId: UuidV7 }> => {
    const failureId = createUuidV7();
    await getDb()
      .insert(taskArtifactFailures)
      .values({
        id: failureId,
        taskRunId: opts.taskRunId,
        projectId: opts.projectId,
        relativeStorePath: opts.relativeStorePath ?? "reports/summary.json",
        attemptedSizeBytes: 2048,
        kind: "generic",
        errorCode: "UPLOAD_HTTP_ERROR",
        errorMessage: "Upload request failed",
        httpStatus: 502,
        createdAt: opts.createdAt,
      });
    return { failureId };
  };

  describe("record", () => {
    test("persists a failure row and returns its contract projection", async () => {
      const { projectId, taskRunId } = await seedTask();

      const failure = await repo.record({
        id: createUuidV7(),
        taskRunId: taskRunId,
        projectId,
        relativeStorePath: "reports/summary.json",
        attemptedSizeBytes: 4096,
        kind: "playwright-trace",
        errorCode: "USAGE_LIMIT_EXCEEDED_STORAGE",
        errorMessage: "Organization storage usage limit reached",
        httpStatus: null,
      });

      expect(failure.taskRunId).toBe(taskRunId);
      expect(failure.relativeStorePath).toBe("reports/summary.json");
      expect(failure.attemptedSizeBytes).toBe(4096);
      expect(failure.kind).toBe("playwright-trace");
      expect(failure.errorCode).toBe("USAGE_LIMIT_EXCEEDED_STORAGE");
      expect(failure.errorMessage).toBe(
        "Organization storage usage limit reached",
      );
      expect(failure.httpStatus).toBeNull();

      const [row] = await getDb()
        .select()
        .from(taskArtifactFailures)
        .where(eq(taskArtifactFailures.id, failure.id));

      expect(row?.taskRunId).toBe(taskRunId);
      expect(row?.projectId).toBe(projectId);
      expect(row?.attemptedSizeBytes).toBe(4096);
    });
  });

  describe("listByTask", () => {
    test("returns failures for the task, newest first", async () => {
      const { projectId, taskRunId } = await seedTask();
      const older = new Date("2026-08-01T00:00:00.000Z");
      const newer = new Date("2026-08-02T00:00:00.000Z");

      const { failureId: olderId } = await seedFailure({
        taskRunId,
        projectId,
        createdAt: older,
        relativeStorePath: "reports/older.json",
      });
      const { failureId: newerId } = await seedFailure({
        taskRunId,
        projectId,
        createdAt: newer,
        relativeStorePath: "reports/newer.json",
      });

      const failures = await repo.listByTask(taskRunId);

      expect(failures).toHaveLength(2);
      expect(failures.map((failure) => failure.id)).toEqual([newerId, olderId]);
      expect(failures[0]?.relativeStorePath).toBe("reports/newer.json");
      expect(failures[1]?.relativeStorePath).toBe("reports/older.json");
    });

    test("returns an empty array when the task has no failures", async () => {
      const { taskRunId } = await seedTask();

      const failures = await repo.listByTask(taskRunId);

      expect(failures).toEqual([]);
    });

    test("does not return another task's failures", async () => {
      const seededA = await seedTask();
      const seededB = await seedTask();
      await seedFailure({
        taskRunId: seededA.taskRunId,
        projectId: seededA.projectId,
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
      });

      const failuresForB = await repo.listByTask(seededB.taskRunId);

      expect(failuresForB).toEqual([]);
    });
  });

  describe("deleteExpiredFailures", () => {
    const NOW = new Date("2026-09-01T00:00:00.000Z");
    const RETENTION_DAYS = 30;

    test("hard-deletes a failure row older than the retention window", async () => {
      const { projectId, taskRunId } = await seedTask();
      const createdAt = new Date(
        NOW.getTime() - (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1_000,
      );
      const { failureId } = await seedFailure({
        taskRunId,
        projectId,
        createdAt,
      });

      await repo.deleteExpiredFailures(NOW, RETENTION_DAYS);

      const [row] = await getDb()
        .select()
        .from(taskArtifactFailures)
        .where(eq(taskArtifactFailures.id, failureId));

      expect(row).toBeUndefined();
    });

    test("leaves a failure created inside the retention window untouched", async () => {
      const { projectId, taskRunId } = await seedTask();
      const createdAt = new Date(
        NOW.getTime() - (RETENTION_DAYS - 1) * 24 * 60 * 60 * 1_000,
      );
      const { failureId } = await seedFailure({
        taskRunId,
        projectId,
        createdAt,
      });

      await repo.deleteExpiredFailures(NOW, RETENTION_DAYS);

      const [row] = await getDb()
        .select()
        .from(taskArtifactFailures)
        .where(eq(taskArtifactFailures.id, failureId));

      expect(row).toBeDefined();
      expect(row?.id).toBe(failureId);
    });

    test("is idempotent: a second call finds nothing left to delete", async () => {
      const { projectId, taskRunId } = await seedTask();
      const createdAt = new Date(
        NOW.getTime() - (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1_000,
      );
      const { failureId } = await seedFailure({
        taskRunId,
        projectId,
        createdAt,
      });

      // No count check on the first sweep: the sweep is global, so another
      // file's sweep (e.g. reconcile-storage.endpoint.test.ts on another
      // `--parallel` worker) may have deleted this row first.
      await repo.deleteExpiredFailures(NOW, RETENTION_DAYS);

      // The row is already gone after the first sweep, so a second call
      // against a later `now` finds nothing new for this row specifically
      // (no error, no re-delete of an already-absent id).
      const laterNow = new Date(NOW.getTime() + 24 * 60 * 60 * 1_000);
      await repo.deleteExpiredFailures(laterNow, RETENTION_DAYS);

      const [row] = await getDb()
        .select()
        .from(taskArtifactFailures)
        .where(eq(taskArtifactFailures.id, failureId));
      expect(row).toBeUndefined();
    });
  });
});
