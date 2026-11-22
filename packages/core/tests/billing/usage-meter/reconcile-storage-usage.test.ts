/**
 * DB-backed coverage for `reconcileStorageUsage` limited to one org: what it
 * clears and how it corrects the meter, and that it leaves every other org's
 * rows and meter alone. Each test seeds its own orgs and reconciles only
 * them, so files running alongside under `bun test --parallel` are unaffected.
 */
import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "bun:test";
import { reconcileStorageUsage } from "@/billing/usage-meter/application/reconcile-storage-usage";
import { currentBillingPeriod } from "@/billing/usage-meter/domain/billing-period";
import { STORAGE_RETENTION_DAYS } from "@/billing/usage-meter/domain/storage-retention";
import { DrizzleStorageUsageReader } from "@/billing/usage-meter/infra/drizzle-storage-usage-reader";
import { DrizzleUsageMeterRepo } from "@/billing/usage-meter/infra/drizzle-usage-meter-repo";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import {
  projects,
  taskArtifacts,
  taskRuns,
  usageMeters,
} from "@/lib/db/schema";
import { DrizzleArtifactFailureRepo } from "@/tasks/task-artifact/infra/drizzle-artifact-failure-repo";
import { DrizzleArtifactRepo } from "@/tasks/task-artifact/infra/drizzle-artifact-repo";
import { DrizzleTaskRunRepo } from "@/tasks/task-run/infra/drizzle-task-run-repo";
import {
  seedTaskPrerequisites,
  seedTaskRunParent,
} from "tests/lib/db/seed-task-prerequisites";
import { fixedTimeProvider } from "tests/utils";

const NOW = new Date("2026-08-15T00:00:00.000Z");
const PERIOD = currentBillingPeriod(NOW);
const daysAgo = (days: number) =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1_000);
const EXPIRED = daysAgo(STORAGE_RETENTION_DAYS + 1);
const KEPT = daysAgo(1);

const usageMeterRepo = new DrizzleUsageMeterRepo();

const reconcile = (orgId: UuidV7) =>
  reconcileStorageUsage({
    usageMeterRepo,
    storageUsageReader: new DrizzleStorageUsageReader(),
    taskRunRepo: new DrizzleTaskRunRepo(),
    artifactRepo: new DrizzleArtifactRepo(),
    artifactFailureRepo: new DrizzleArtifactFailureRepo(),
    timeProvider: fixedTimeProvider(NOW),
    orgId,
  });

/** Seeds an org with one project; returns ids to hang storage rows off. */
const seedOrg = async () => {
  const db = getDb();
  const orgId = createUuidV7();
  const projectId = createUuidV7();
  await db.insert(projects).values({
    id: projectId,
    name: "Reconcile storage test project",
    slug: `reconcile-storage-${crypto.randomUUID()}`,
    gitUrl: "https://github.com/example/test-project.git",
    createdByUserId: createUuidV7(),
    orgId,
  });
  const { workItemId } = await seedTaskPrerequisites(projectId, db);
  return { orgId, projectId, workItemId };
};

type Org = Awaited<ReturnType<typeof seedOrg>>;

const seedSession = async (
  org: Org,
  sizeBytes: number,
  completedAt: Date,
): Promise<UuidV7> => {
  const db = getDb();
  const id = createUuidV7();
  await db.insert(taskRuns).values({
    id,
    projectId: org.projectId,
    workItemId: org.workItemId,
    ...(await seedTaskRunParent(org, db)),
    status: "yielded",
    completedAt,
    sessionObjectKey: `tasks/${id}/session.json`,
    sessionSizeBytes: sizeBytes,
  });
  return id;
};

const seedArtifact = async (org: Org, sizeBytes: number, createdAt: Date) => {
  const db = getDb();
  const taskRunId = createUuidV7();
  await db.insert(taskRuns).values({
    id: taskRunId,
    projectId: org.projectId,
    workItemId: org.workItemId,
    ...(await seedTaskRunParent(org, db)),
    status: "succeeded",
  });
  const objectKey = `artifacts/${org.projectId}/${taskRunId}/report.json`;
  await db.insert(taskArtifacts).values({
    id: createUuidV7(),
    taskRunId,
    projectId: org.projectId,
    relativeStorePath: "report.json",
    objectKey,
    storeRef: `s3://bucket/${objectKey}`,
    sizeBytes,
    createdAt,
  });
};

const sessionKeyOf = async (runId: UuidV7) =>
  (
    await getDb()
      .select({ key: taskRuns.sessionObjectKey })
      .from(taskRuns)
      .where(eq(taskRuns.id, runId))
  )[0]?.key;

const storageBytesOf = async (orgId: UuidV7) =>
  (
    await getDb()
      .select({ storageBytes: usageMeters.storageBytes })
      .from(usageMeters)
      .where(and(eq(usageMeters.orgId, orgId), eq(usageMeters.period, PERIOD)))
  )[0]?.storageBytes;

const setStorageBytes = async (orgId: UuidV7, storageBytes: number) => {
  const meter = await usageMeterRepo.loadOrStart(orgId, PERIOD, "free");
  await usageMeterRepo.save(meter.withStorageBytes(storageBytes));
};

describe("reconcileStorageUsage for one org", () => {
  test.concurrent(
    "clears its expired sessions and sets its meter to what it retains",
    async () => {
      const org = await seedOrg();
      const kept = await seedSession(org, 300, KEPT);
      const expired = await seedSession(org, 700, EXPIRED);
      await seedArtifact(org, 2000, KEPT);
      await setStorageBytes(org.orgId, 99_999);

      await reconcile(org.orgId);

      expect(await sessionKeyOf(kept)).toBe(`tasks/${kept}/session.json`);
      expect(await sessionKeyOf(expired)).toBeNull();
      expect(await storageBytesOf(org.orgId)).toBe(300 + 2000);
    },
  );

  test.concurrent(
    "floors its meter to 0 once everything it stored has expired",
    async () => {
      const org = await seedOrg();
      await seedSession(org, 700, EXPIRED);
      await setStorageBytes(org.orgId, 700);

      await reconcile(org.orgId);

      expect(await storageBytesOf(org.orgId)).toBe(0);
    },
  );

  test.concurrent(
    "keeps its artifact bytes across repeated runs instead of flooring them",
    async () => {
      const org = await seedOrg();
      await seedArtifact(org, 8192, KEPT);

      await reconcile(org.orgId);
      expect(await storageBytesOf(org.orgId)).toBe(8192);

      await reconcile(org.orgId);
      expect(await storageBytesOf(org.orgId)).toBe(8192);
    },
  );

  test.concurrent(
    "leaves another org's expired session and meter alone",
    async () => {
      const target = await seedOrg();
      const other = await seedOrg();
      const otherExpired = await seedSession(other, 700, EXPIRED);
      await setStorageBytes(other.orgId, 1234);

      await reconcile(target.orgId);

      expect(await sessionKeyOf(otherExpired)).toBe(
        `tasks/${otherExpired}/session.json`,
      );
      expect(await storageBytesOf(other.orgId)).toBe(1234);
    },
  );
});
