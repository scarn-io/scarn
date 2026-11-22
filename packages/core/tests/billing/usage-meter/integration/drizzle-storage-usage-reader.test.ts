import { randomInt } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "bun:test";
import { getDb } from "@/lib/db";
import {
  projects,
  taskArtifacts,
  taskRuns,
  usageMeters,
} from "@/lib/db/schema";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { DrizzleStorageUsageReader } from "@/billing/usage-meter/infra/drizzle-storage-usage-reader";
import { DrizzleUsageMeterRepo } from "@/billing/usage-meter/infra/drizzle-usage-meter-repo";
import {
  seedTaskRunParent,
  seedTaskPrerequisites,
} from "tests/lib/db/seed-task-prerequisites";

/**
 * Integration coverage for `DrizzleStorageUsageReader.sumRetainedBytesByOrg`,
 * specifically:
 *  - the Phase 0 fix: artifact bytes (`task_artifacts.size_bytes`)
 *    must be counted, not silently discarded. Prior to this fix the reader
 *    only summed `task_runs.log_archive_size_bytes`, so an org with
 *    artifacts but no log archives was reconciled to a `storageBytes` of 0 —
 *    "free storage forever".
 *  - the Phase 2 fix: artifact bytes must be excluded once the artifact's
 *    `createdAt` (its aging anchor) ages past `retentionDays`, mirroring the
 *    cutoff already applied to log archives via `logArchivedAt`.
 *
 * Rows are seeded directly via Drizzle (project -> work item + capability
 * profile -> task -> artifact), the same same-schema-FK chain the API itself
 * writes, rather than driving the HTTP surface — this file lives under the
 * integration test tree but only imports the `infra` layer, which the
 * integration-boundary ESLint rule permits (it only restricts imports from
 * an `application` layer directory).
 *
 * Each test generates its own random org id, so `sumRetainedBytesByOrg`'s
 * whole-table scan (it is not scoped to a period or set of orgs) can be
 * asserted on via `rows.find(... === orgId)` without interference from other
 * tests or leftover rows in the shared test-container database.
 */
describe("DrizzleStorageUsageReader.sumRetainedBytesByOrg", () => {
  const reader = new DrizzleStorageUsageReader();
  const usageMeterRepo = new DrizzleUsageMeterRepo();
  const NOW = new Date("2026-08-01T00:00:00.000Z");
  const RETENTION_DAYS = 30;

  /**
   * Seeds a project owned by a fresh random org, plus one task
   * (optionally carrying a present log archive) with one artifact attached.
   * Returns the org id so callers can pick their own rows out of the reader's
   * whole-table result.
   */
  const seedProjectWithArtifact = async (opts: {
    artifactSizeBytes: number;
    logArchiveSizeBytes?: number;
    /** Defaults to `NOW` (i.e. inside the retention window). */
    artifactCreatedAt?: Date;
  }): Promise<{ orgId: UuidV7 }> => {
    const db = getDb();
    const orgId = createUuidV7();
    const projectId = createUuidV7();
    const taskId = createUuidV7();
    const artifactId = createUuidV7();
    const hasLogArchive = opts.logArchiveSizeBytes !== undefined;

    await db.insert(projects).values({
      id: projectId,
      name: "Storage reader test project",
      slug: `storage-reader-${crypto.randomUUID()}`,
      gitUrl: "https://github.com/example/test-project.git",
      createdByUserId: createUuidV7(),
      orgId,
    });

    const { workItemId } = await seedTaskPrerequisites(projectId, db);

    await db.insert(taskRuns).values({
      id: taskId,
      projectId,
      workItemId,
      ...(await seedTaskRunParent({ projectId, workItemId }, db)),
      status: "succeeded",
      logArchiveStoreRef: hasLogArchive ? "s3://bucket/archive.ndjson" : null,
      logArchiveSizeBytes: opts.logArchiveSizeBytes ?? null,
      logArchivedAt: hasLogArchive ? NOW : null,
    });

    const objectKey = `artifacts/${projectId}/${taskId}/reports/summary.json`;
    await db.insert(taskArtifacts).values({
      id: artifactId,
      taskRunId: taskId,
      projectId,
      relativeStorePath: "reports/summary.json",
      objectKey,
      storeRef: `s3://bucket/${objectKey}`,
      sizeBytes: opts.artifactSizeBytes,
      createdAt: opts.artifactCreatedAt ?? NOW,
    });

    return { orgId };
  };

  test.concurrent(
    "includes an org's artifact bytes in the retained total",
    async () => {
      const { orgId } = await seedProjectWithArtifact({
        artifactSizeBytes: 2048,
      });

      const rows = await reader.sumRetainedBytesByOrg(NOW, RETENTION_DAYS);
      const row = rows.find((r) => r.orgId === orgId);

      expect(row?.bytes).toBe(2048);
    },
  );

  test.concurrent(
    "combines artifact bytes with log-archive bytes for the same org",
    async () => {
      const { orgId } = await seedProjectWithArtifact({
        artifactSizeBytes: 1024,
        logArchiveSizeBytes: 4096,
      });

      const rows = await reader.sumRetainedBytesByOrg(NOW, RETENTION_DAYS);
      const row = rows.find((r) => r.orgId === orgId);

      expect(row?.bytes).toBe(1024 + 4096);
    },
  );

  test.concurrent(
    "excludes an org's artifact bytes once createdAt ages past the retention window",
    async () => {
      const createdAt = new Date(
        NOW.getTime() - (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1_000,
      );
      const { orgId } = await seedProjectWithArtifact({
        artifactSizeBytes: 2048,
        artifactCreatedAt: createdAt,
      });

      const rows = await reader.sumRetainedBytesByOrg(NOW, RETENTION_DAYS);
      const row = rows.find((r) => r.orgId === orgId);

      // No log archive and an expired artifact means this org retains
      // nothing — it should be omitted entirely, not present with 0 bytes.
      expect(row).toBeUndefined();
    },
  );

  test.concurrent(
    "includes an org's artifact bytes when createdAt is inside the retention window",
    async () => {
      const createdAt = new Date(
        NOW.getTime() - (RETENTION_DAYS - 1) * 24 * 60 * 60 * 1_000,
      );
      const { orgId } = await seedProjectWithArtifact({
        artifactSizeBytes: 2048,
        artifactCreatedAt: createdAt,
      });

      const rows = await reader.sumRetainedBytesByOrg(NOW, RETENTION_DAYS);
      const row = rows.find((r) => r.orgId === orgId);

      expect(row?.bytes).toBe(2048);
    },
  );

  test("a second reconciliation run does not floor the org's storageBytes back to 0", async () => {
    const period = `${String(randomInt(2100, 3000))}-01`;
    const { orgId } = await seedProjectWithArtifact({
      artifactSizeBytes: 8192,
    });

    const firstRetained = await reader.sumRetainedBytesByOrg(
      NOW,
      RETENTION_DAYS,
    );
    await usageMeterRepo.reconcileStorageForPeriod(
      period,
      firstRetained,
      "free",
    );

    const secondRetained = await reader.sumRetainedBytesByOrg(
      NOW,
      RETENTION_DAYS,
    );
    await usageMeterRepo.reconcileStorageForPeriod(
      period,
      secondRetained,
      "free",
    );

    const [meter] = await getDb()
      .select()
      .from(usageMeters)
      .where(and(eq(usageMeters.orgId, orgId), eq(usageMeters.period, period)));

    expect(meter?.storageBytes).toBe(8192);
  });
});
