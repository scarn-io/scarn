import { describe, expect } from "bun:test";
import { concurrentTest } from "tests/utils";
import { getDb } from "@/lib/db";
import { projects, workItems } from "@/lib/db/schema";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import {
  createWorkItemId,
  type WorkItemId,
} from "@/work-items/work-item/domain/work-item-id";
import { DrizzleGithubRelationshipPendingRefRepo } from "@/integrations/github-ingest/infra/drizzle-github-relationship-pending-ref-repo";

/**
 * Integration coverage for Phase 2 of
 * `docs/github-relationship-pending-references-plan.md`. This repo has no
 * user-facing API (Decision 8), so it's exercised directly via Drizzle,
 * mirroring `drizzle-artifact-repo.test.ts`'s pattern rather than going
 * through the API client.
 */
describe("DrizzleGithubRelationshipPendingRefRepo", () => {
  const repo = new DrizzleGithubRelationshipPendingRefRepo();

  /** Seeds a project -> work item chain to satisfy the table's FKs. */
  const seedProjectAndWorkItem = async (): Promise<{
    projectId: UuidV7;
    workItemId: WorkItemId;
  }> => {
    const db = getDb();
    const projectId = createUuidV7();
    const workItemId = createWorkItemId();

    await db.insert(projects).values({
      id: projectId,
      name: "Pending ref repo test project",
      slug: `pending-ref-repo-${crypto.randomUUID()}`,
      gitUrl: "https://github.com/example/test-project.git",
      createdByUserId: createUuidV7(),
      orgId: createUuidV7(),
    });

    await db.insert(workItems).values({
      id: workItemId,
      projectId,
      platform: "github",
      platformKey: `example/repo#${String(Math.floor(Math.random() * 100_000))}`,
      title: "Pending ref repo test work item",
    });

    return { projectId, workItemId };
  };

  concurrentTest(
    "listByProjectId returns only rows scoped to the given project",
    async () => {
      const seedA = await seedProjectAndWorkItem();
      const seedB = await seedProjectAndWorkItem();

      await repo.upsertMany([
        {
          projectId: seedA.projectId,
          workItemId: seedA.workItemId,
          kind: "parent",
          targetPlatformKey: "owner/repo#1",
        },
        {
          projectId: seedB.projectId,
          workItemId: seedB.workItemId,
          kind: "parent",
          targetPlatformKey: "owner/repo#2",
        },
      ]);

      const rowsForA = await repo.listByProjectId(seedA.projectId);

      expect(rowsForA).toHaveLength(1);
      expect(rowsForA[0]?.projectId).toBe(seedA.projectId);
      expect(rowsForA[0]?.workItemId).toBe(seedA.workItemId);
      expect(rowsForA[0]?.kind).toBe("parent");
      expect(rowsForA[0]?.targetPlatformKey).toBe("owner/repo#1");
    },
  );

  concurrentTest(
    "upsertMany inserts new rows and no-ops on a conflicting (workItemId, kind, targetPlatformKey)",
    async () => {
      const seed = await seedProjectAndWorkItem();
      const ref = {
        projectId: seed.projectId,
        workItemId: seed.workItemId,
        kind: "blocked_by" as const,
        targetPlatformKey: "owner/repo#42",
      };

      await repo.upsertMany([ref]);
      await repo.upsertMany([ref]);

      const rows = await repo.listByProjectId(seed.projectId);
      expect(rows).toHaveLength(1);
    },
  );

  concurrentTest("upsertMany is a no-op for an empty array", async () => {
    const seed = await seedProjectAndWorkItem();

    await repo.upsertMany([]);

    const rows = await repo.listByProjectId(seed.projectId);
    expect(rows).toHaveLength(0);
  });

  concurrentTest(
    "deleteMany removes only rows matching the (workItemId, kind, targetPlatformKey) identity",
    async () => {
      const seed = await seedProjectAndWorkItem();

      await repo.upsertMany([
        {
          projectId: seed.projectId,
          workItemId: seed.workItemId,
          kind: "parent",
          targetPlatformKey: "owner/repo#1",
        },
        {
          projectId: seed.projectId,
          workItemId: seed.workItemId,
          kind: "blocked_by",
          targetPlatformKey: "owner/repo#2",
        },
      ]);

      await repo.deleteMany([
        {
          workItemId: seed.workItemId,
          kind: "parent",
          targetPlatformKey: "owner/repo#1",
        },
      ]);

      const rows = await repo.listByProjectId(seed.projectId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("blocked_by");
      expect(rows[0]?.targetPlatformKey).toBe("owner/repo#2");
    },
  );

  concurrentTest("deleteMany is a no-op for an empty array", async () => {
    const seed = await seedProjectAndWorkItem();
    await repo.upsertMany([
      {
        projectId: seed.projectId,
        workItemId: seed.workItemId,
        kind: "parent",
        targetPlatformKey: "owner/repo#1",
      },
    ]);

    await repo.deleteMany([]);

    const rows = await repo.listByProjectId(seed.projectId);
    expect(rows).toHaveLength(1);
  });

  concurrentTest(
    "deleteMany leaves a differently-keyed pending row for the same work item untouched",
    async () => {
      const seed = await seedProjectAndWorkItem();

      await repo.upsertMany([
        {
          projectId: seed.projectId,
          workItemId: seed.workItemId,
          kind: "parent",
          targetPlatformKey: "owner/repo#1",
        },
      ]);

      await repo.deleteMany([
        {
          workItemId: seed.workItemId,
          kind: "parent",
          // Different target key: does not match the seeded row's identity.
          targetPlatformKey: "owner/repo#999",
        },
      ]);

      const rows = await repo.listByProjectId(seed.projectId);
      expect(rows).toHaveLength(1);
    },
  );
});
