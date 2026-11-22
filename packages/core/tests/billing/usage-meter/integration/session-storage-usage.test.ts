import { eq } from "drizzle-orm";
import { describe, expect, test } from "bun:test";
import { getDb } from "@/lib/db";
import { projects, taskRuns } from "@/lib/db/schema";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { DrizzleStorageUsageReader } from "@/billing/usage-meter/infra/drizzle-storage-usage-reader";
import { DrizzleTaskRunRepo } from "@/tasks/task-run/infra/drizzle-task-run-repo";
import {
  seedTaskPrerequisites,
  seedTaskRunParent,
} from "tests/lib/db/seed-task-prerequisites";

/**
 * Saved agent sessions in storage usage: the reader counts
 * `session_size_bytes` of runs whose session is still kept and inside the
 * retention window (aged by `completed_at`), and `clearExpiredSessions`
 * clears the columns of sessions past it. Each test seeds its own org, and
 * clears only that org's sessions so it never touches other files' rows.
 */
describe("saved agent sessions in storage usage", () => {
  const reader = new DrizzleStorageUsageReader();
  const taskRunRepo = new DrizzleTaskRunRepo();
  const NOW = new Date("2026-08-01T00:00:00.000Z");
  const RETENTION_DAYS = 30;
  const daysAgo = (days: number) =>
    new Date(NOW.getTime() - days * 24 * 60 * 60 * 1_000);

  const seedOrg = async (
    sessions: { sizeBytes: number | null; completedAt: Date }[],
  ): Promise<{ orgId: UuidV7; runIds: UuidV7[] }> => {
    const db = getDb();
    const orgId = createUuidV7();
    const projectId = createUuidV7();
    await db.insert(projects).values({
      id: projectId,
      name: "Session storage test project",
      slug: `session-storage-${crypto.randomUUID()}`,
      gitUrl: "https://github.com/example/test-project.git",
      createdByUserId: createUuidV7(),
      orgId,
    });
    const { workItemId } = await seedTaskPrerequisites(projectId, db);
    const runIds: UuidV7[] = [];
    for (const session of sessions) {
      const id = createUuidV7();
      runIds.push(id);
      await db.insert(taskRuns).values({
        id,
        projectId,
        workItemId,
        ...(await seedTaskRunParent({ projectId, workItemId }, db)),
        status: "yielded",
        completedAt: session.completedAt,
        sessionObjectKey: `tasks/${id}/session.json`,
        sessionSizeBytes: session.sizeBytes,
      });
    }
    return { orgId, runIds };
  };

  test.concurrent(
    "counts sessions inside the retention window and excludes older ones",
    async () => {
      const { orgId } = await seedOrg([
        { sizeBytes: 3000, completedAt: daysAgo(1) },
        { sizeBytes: 500, completedAt: daysAgo(RETENTION_DAYS + 1) },
      ]);

      const rows = await reader.sumRetainedBytesByOrg(NOW, RETENTION_DAYS);
      const breakdown = await reader.getRetainedBytesBreakdownForOrg(
        orgId,
        NOW,
        RETENTION_DAYS,
      );

      expect(rows.find((row) => row.orgId === orgId)?.bytes).toBe(3000);
      expect(breakdown).toEqual({
        artifactBytes: 0,
        logBytes: 0,
        sessionBytes: 3000,
      });
    },
  );

  test.concurrent("ignores sessions saved with no size", async () => {
    const { orgId } = await seedOrg([
      { sizeBytes: null, completedAt: daysAgo(1) },
      { sizeBytes: 700, completedAt: daysAgo(2) },
    ]);

    const breakdown = await reader.getRetainedBytesBreakdownForOrg(
      orgId,
      NOW,
      RETENTION_DAYS,
    );

    expect(breakdown.sessionBytes).toBe(700);
  });

  test.concurrent(
    "clearExpiredSessions clears only the sessions past the window",
    async () => {
      const {
        orgId,
        runIds: [kept, expired],
      } = await seedOrg([
        { sizeBytes: 100, completedAt: daysAgo(1) },
        { sizeBytes: 200, completedAt: daysAgo(RETENTION_DAYS + 1) },
      ]);

      expect(
        await taskRunRepo.clearExpiredSessions(
          NOW,
          RETENTION_DAYS,
          undefined,
          orgId,
        ),
      ).toBe(1);

      const columns = async (id: UuidV7 | undefined) =>
        (
          await getDb()
            .select({
              key: taskRuns.sessionObjectKey,
              size: taskRuns.sessionSizeBytes,
            })
            .from(taskRuns)
            .where(eq(taskRuns.id, id ?? createUuidV7()))
        )[0];
      expect(await columns(kept)).toEqual({
        key: `tasks/${String(kept)}/session.json`,
        size: 100,
      });
      expect(await columns(expired)).toEqual({ key: null, size: null });
    },
  );

  test.concurrent(
    "clearExpiredSessions for one org leaves another org's expired sessions",
    async () => {
      const expiredAgo = daysAgo(RETENTION_DAYS + 1);
      const target = await seedOrg([
        { sizeBytes: 100, completedAt: expiredAgo },
      ]);
      const other = await seedOrg([
        { sizeBytes: 200, completedAt: expiredAgo },
      ]);

      expect(
        await taskRunRepo.clearExpiredSessions(
          NOW,
          RETENTION_DAYS,
          undefined,
          target.orgId,
        ),
      ).toBe(1);

      const [otherRun] = await getDb()
        .select({ key: taskRuns.sessionObjectKey })
        .from(taskRuns)
        .where(eq(taskRuns.id, other.runIds[0] ?? createUuidV7()));
      expect(otherRun?.key).toBe(`tasks/${String(other.runIds[0])}/session.json`);
    },
  );
});
