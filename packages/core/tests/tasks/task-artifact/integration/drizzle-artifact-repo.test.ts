/* eslint max-lines: off */
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, test } from "bun:test";
import { getDb } from "@/lib/db";
import {
  nodeVisits,
  pipelineGraphVersions,
  pipelineGraphs,
  pipelineRuns,
  projects,
  stepDefinitions,
  taskArtifacts,
  taskRuns,
} from "@/lib/db/schema";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { DrizzleArtifactRepo } from "@/tasks/task-artifact/infra/drizzle-artifact-repo";
import {
  seedTaskRunParent,
  seedTaskPrerequisites,
} from "tests/lib/db/seed-task-prerequisites";

/**
 * Integration coverage for `DrizzleArtifactRepo`: `clearExpiredArtifacts`
 * (Phase 2), and `listByProjectId`/`findManyByIds`/`softDeleteMany` plus the
 * soft-delete exclusion on `listByTask`/`findById` (Phase 10).
 *
 * Rows are seeded directly via Drizzle (project -> step definition -> step
 * execution -> artifact), the same FK chain the API itself writes.
 */
describe("DrizzleArtifactRepo", () => {
  const repo = new DrizzleArtifactRepo();

  type ArtifactScope = {
    projectId: UuidV7;
    stepDefinitionId: UuidV7;
    workItemId: UuidV7;
  };

  /**
   * Seeds a project, its Task prerequisites (a work item)
   * and a step definition. Several artifacts can share one scope for
   * ordering/pagination/exclusion assertions.
   */
  const seedArtifactScope = async (
    label = "Artifact repo",
  ): Promise<ArtifactScope> => {
    const db = getDb();
    const projectId = createUuidV7();
    const stepDefinitionId = createUuidV7();

    await db.insert(projects).values({
      id: projectId,
      name: `${label} test project`,
      slug: `artifact-repo-${crypto.randomUUID()}`,
      gitUrl: "https://github.com/example/test-project.git",
      createdByUserId: createUuidV7(),
      orgId: createUuidV7(),
    });

    const { workItemId } = await seedTaskPrerequisites(projectId, db);
    await db.insert(stepDefinitions).values({
      id: stepDefinitionId,
      projectId,
      key: `artifact_repo_step_${crypto.randomUUID()}`,
      name: `${label} step`,
      version: 1,
      kind: "user_defined",
      inputSchemaJson: { type: "object" },
      resultSchemaJson: { type: "object" },
      status: "active",
    });

    return { projectId, stepDefinitionId, workItemId };
  };

  /**
   * Seeds a task -> artifact chain. `scope` may be supplied to
   * reuse an already-seeded project; omitted, each seeds a fresh one,
   * matching this file's original single-artifact-per-project behavior.
   */
  const seedArtifact = async (opts: {
    createdAt: Date;
    sizeBytes?: number;
    scope?: ArtifactScope;
    deletedAt?: Date | null;
  }): Promise<
    ArtifactScope & {
      artifactId: UuidV7;
      taskRunId: UuidV7;
    }
  > => {
    const db = getDb();
    const scope = opts.scope ?? (await seedArtifactScope());
    const { projectId } = scope;
    const taskRunId = createUuidV7();
    const artifactId = createUuidV7();

    await db.insert(taskRuns).values({
      id: taskRunId,
      projectId,
      workItemId: scope.workItemId,
      ...(await seedTaskRunParent(
        { projectId, workItemId: scope.workItemId },
        db,
      )),
      status: "succeeded",
    });

    const objectKey = `artifacts/${projectId}/${taskRunId}/reports/summary.json`;
    await db.insert(taskArtifacts).values({
      id: artifactId,
      taskRunId: taskRunId,
      projectId,
      relativeStorePath: "reports/summary.json",
      objectKey,
      storeRef: `s3://bucket/${objectKey}`,
      sizeBytes: opts.sizeBytes ?? 2048,
      contentType: "application/json",
      createdAt: opts.createdAt,
      deletedAt: opts.deletedAt ?? null,
    });

    return { ...scope, artifactId, taskRunId };
  };

  /**
   * Bulk-seeds `count` artifacts (and their backing task runs) under
   * one project/step definition in a couple of batch inserts — used for the
   * `listByProjectId` limit-boundary test, where seeding 50-51 rows one at a
   * time via `seedArtifact` would be needlessly slow.
   */
  const seedArtifactsBulk = async (
    scope: ArtifactScope,
    count: number,
    baseTime: Date,
  ): Promise<UuidV7[]> => {
    const db = getDb();
    const { projectId } = scope;
    const taskIds = Array.from({ length: count }, () => createUuidV7());
    const parent = await seedTaskRunParent(
      { projectId, workItemId: scope.workItemId },
      db,
    );
    await db.insert(taskRuns).values(
      taskIds.map((id, index) => ({
        id,
        projectId,
        workItemId: scope.workItemId,
        ...parent,
        number: index + 1,
        status: "succeeded" as const,
      })),
    );

    const artifactIds = taskIds.map(() => createUuidV7());
    await db.insert(taskArtifacts).values(
      taskIds.map((taskRunId, index) => {
        const artifactId = artifactIds[index];
        if (!artifactId) {
          throw new Error("Expected a generated artifact id");
        }
        const objectKey = `artifacts/${projectId}/${taskRunId}/reports/summary.json`;
        return {
          id: artifactId,
          taskRunId: taskRunId,
          projectId,
          relativeStorePath: "reports/summary.json",
          objectKey,
          storeRef: `s3://bucket/${objectKey}`,
          sizeBytes: 2048,
          contentType: "application/json",
          createdAt: new Date(baseTime.getTime() + index * 1_000),
        };
      }),
    );

    return artifactIds;
  };

  /**
   * Seeds the minimal FK chain a node visit needs (pipeline graph -> version
   * -> pipeline run -> node visit), pointed at the Task of an already-seeded
   * artifact's `taskRunId`, so `listByProjectId`'s `nodeKey` join has a row to
   * match.
   */
  const seedNodeVisit = async (opts: {
    scope: ArtifactScope;
    taskRunId: UuidV7;
    nodeKey: string;
  }): Promise<void> => {
    const db = getDb();
    const { projectId, workItemId } = opts.scope;
    const pipelineGraphId = createUuidV7();
    const pipelineGraphVersionId = createUuidV7();
    const pipelineRunId = createUuidV7();
    const nodeVisitId = createUuidV7();
    const [run] = await db
      .select({ taskId: taskRuns.taskId })
      .from(taskRuns)
      .where(eq(taskRuns.id, opts.taskRunId));

    await db.insert(pipelineGraphs).values({
      id: pipelineGraphId,
      projectId,
      key: `node_visit_graph_${crypto.randomUUID()}`,
      name: "Node visit graph",
    });

    await db.insert(pipelineGraphVersions).values({
      id: pipelineGraphVersionId,
      pipelineGraphId,
      version: 1,
      definitionJson: {},
      schemaVersion: 1,
      contentHash: crypto.randomUUID(),
    });

    await db.insert(pipelineRuns).values({
      id: pipelineRunId,
      projectId,
      workItemId,
      pipelineGraphId,
      pipelineGraphVersionId,
      status: "active",
    });

    await db.insert(nodeVisits).values({
      id: nodeVisitId,
      pipelineRunId,
      nodeId: opts.nodeKey,
      nodeKind: "step",
      transitionJson: {},
      status: "active",
      inputJson: {},
      taskId: run?.taskId ?? null,
      createdAt: new Date(),
    });
  };

  describe("clearExpiredArtifacts", () => {
    const NOW = new Date("2026-08-01T00:00:00.000Z");
    const RETENTION_DAYS = 30;

    test("nulls objectKey/storeRef/sizeBytes/contentType for an artifact older than the retention window", async () => {
      const createdAt = new Date(
        NOW.getTime() - (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1_000,
      );
      const { artifactId } = await seedArtifact({ createdAt });

      const clearedCount = await repo.clearExpiredArtifacts(
        NOW,
        RETENTION_DAYS,
      );
      expect(clearedCount).toBeGreaterThanOrEqual(1);

      const [row] = await getDb()
        .select()
        .from(taskArtifacts)
        .where(eq(taskArtifacts.id, artifactId));

      expect(row?.objectKey).toBeNull();
      expect(row?.storeRef).toBeNull();
      expect(row?.sizeBytes).toBeNull();
      expect(row?.contentType).toBeNull();
    });

    test("leaves an artifact created inside the retention window untouched", async () => {
      const createdAt = new Date(
        NOW.getTime() - (RETENTION_DAYS - 1) * 24 * 60 * 60 * 1_000,
      );
      const { artifactId } = await seedArtifact({
        createdAt,
        sizeBytes: 4096,
      });

      await repo.clearExpiredArtifacts(NOW, RETENTION_DAYS);

      const [row] = await getDb()
        .select()
        .from(taskArtifacts)
        .where(eq(taskArtifacts.id, artifactId));

      expect(row?.objectKey).not.toBeNull();
      expect(row?.storeRef).not.toBeNull();
      expect(row?.sizeBytes).toBe(4096);
      expect(row?.contentType).not.toBeNull();
    });

    test("is idempotent: a second call is a no-op for an already-cleared row", async () => {
      const createdAt = new Date(
        NOW.getTime() - (RETENTION_DAYS + 1) * 24 * 60 * 60 * 1_000,
      );
      const { artifactId } = await seedArtifact({ createdAt });

      await repo.clearExpiredArtifacts(NOW, RETENTION_DAYS);
      const [afterFirst] = await getDb()
        .select()
        .from(taskArtifacts)
        .where(eq(taskArtifacts.id, artifactId));
      expect(afterFirst?.storeRef).toBeNull();

      // The row's storeRef is already null, so the `isNotNull(storeRef)`
      // guard excludes it from the second sweep — no error, no change.
      const laterNow = new Date(NOW.getTime() + 24 * 60 * 60 * 1_000);
      await repo.clearExpiredArtifacts(laterNow, RETENTION_DAYS);

      const [afterSecond] = await getDb()
        .select()
        .from(taskArtifacts)
        .where(eq(taskArtifacts.id, artifactId));
      expect(afterSecond?.storeRef).toBeNull();
      expect(afterSecond?.objectKey).toBeNull();
      expect(afterSecond?.sizeBytes).toBeNull();
    });
  });

  describe("listByProjectId", () => {
    test("returns artifacts newest-first, excluding other-project and soft-deleted rows", async () => {
      const base = new Date("2026-08-10T00:00:00.000Z");
      const oldest = await seedArtifact({ createdAt: base });
      const { projectId } = oldest;
      const middle = await seedArtifact({
        createdAt: new Date(base.getTime() + 60_000),
        scope: oldest,
      });
      const newest = await seedArtifact({
        createdAt: new Date(base.getTime() + 120_000),
        scope: oldest,
      });
      // Different project — must never appear in this project's list.
      const otherProject = await seedArtifact({
        createdAt: new Date(base.getTime() + 180_000),
      });
      // Same project, but soft-deleted — must be excluded despite being
      // the newest by `createdAt`.
      const softDeleted = await seedArtifact({
        createdAt: new Date(base.getTime() + 240_000),
        scope: oldest,
        deletedAt: new Date(base.getTime() + 300_000),
      });

      const rows = await repo.listByProjectId(projectId, 50);

      expect(rows.map((row) => row.id)).toEqual([
        newest.artifactId,
        middle.artifactId,
        oldest.artifactId,
      ]);
      expect(rows.some((row) => row.id === otherProject.artifactId)).toBe(
        false,
      );
      expect(rows.some((row) => row.id === softDeleted.artifactId)).toBe(false);
    });

    test("returns exactly `limit` rows when exactly `limit` exist, and `limit + 1` when one more exists", async () => {
      const scope = await seedArtifactScope("Artifact repo boundary");

      const baseTime = new Date("2026-08-20T00:00:00.000Z");
      await seedArtifactsBulk(scope, 50, baseTime);

      const exactlyFifty = await repo.listByProjectId(scope.projectId, 50);
      expect(exactlyFifty.length).toBe(50);

      await seedArtifactsBulk(
        scope,
        1,
        new Date(baseTime.getTime() + 50 * 1_000),
      );
      const fiftyOne = await repo.listByProjectId(scope.projectId, 50);
      expect(fiftyOne.length).toBe(51);
    });

    test("annotates each row with the originating node visit's node id, null when no visit points at the task", async () => {
      const base = new Date("2026-08-11T00:00:00.000Z");
      const withNode = await seedArtifact({ createdAt: base });
      const withoutNode = await seedArtifact({
        createdAt: new Date(base.getTime() + 60_000),
        scope: withNode,
      });

      await seedNodeVisit({
        scope: withNode,
        taskRunId: withNode.taskRunId,
        nodeKey: "triage",
      });

      const rows = await repo.listByProjectId(withNode.projectId, 50);
      const withNodeRow = rows.find((row) => row.id === withNode.artifactId);
      const withoutNodeRow = rows.find(
        (row) => row.id === withoutNode.artifactId,
      );

      expect(withNodeRow?.nodeKey).toBe("triage");
      expect(withoutNodeRow?.nodeKey).toBeNull();
    });
  });

  describe("findManyByIds", () => {
    test("returns only existing artifacts, silently omitting a missing id", async () => {
      const base = new Date("2026-08-12T00:00:00.000Z");
      const a = await seedArtifact({ createdAt: base });
      const b = await seedArtifact({
        createdAt: new Date(base.getTime() + 60_000),
        scope: a,
      });
      const missingId = createUuidV7();

      const found = await repo.findManyByIds([
        a.artifactId,
        b.artifactId,
        missingId,
      ]);

      expect(found).toHaveLength(2);
      expect(found.map((row) => row.id).sort()).toEqual(
        [a.artifactId, b.artifactId].sort(),
      );
    });
  });

  describe("softDeleteMany", () => {
    test("soft-deletes active artifacts, nulling the same four columns clearExpiredArtifacts does", async () => {
      const now = new Date("2026-08-13T00:00:00.000Z");
      const a = await seedArtifact({ createdAt: now });
      const b = await seedArtifact({
        createdAt: now,
        scope: a,
      });

      const deletedIds = await repo.softDeleteMany(
        [a.artifactId, b.artifactId],
        now,
      );
      expect([...deletedIds].sort()).toEqual(
        [a.artifactId, b.artifactId].sort(),
      );

      const rows = await getDb()
        .select()
        .from(taskArtifacts)
        .where(inArray(taskArtifacts.id, [a.artifactId, b.artifactId]));
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.deletedAt).not.toBeNull();
        expect(row.objectKey).toBeNull();
        expect(row.storeRef).toBeNull();
        expect(row.sizeBytes).toBeNull();
        expect(row.contentType).toBeNull();
      }
    });

    test("is idempotent: re-deleting an already-deleted artifact is a no-op that preserves the original deletedAt", async () => {
      const now = new Date("2026-08-14T00:00:00.000Z");
      const a = await seedArtifact({ createdAt: now });

      const firstDeleted = await repo.softDeleteMany([a.artifactId], now);
      expect(firstDeleted).toEqual([a.artifactId]);

      const [afterFirst] = await getDb()
        .select()
        .from(taskArtifacts)
        .where(eq(taskArtifacts.id, a.artifactId));
      const originalDeletedAt = afterFirst?.deletedAt;
      expect(originalDeletedAt).not.toBeNull();

      const laterNow = new Date(now.getTime() + 60_000);
      const secondDeleted = await repo.softDeleteMany([a.artifactId], laterNow);
      expect(secondDeleted).toEqual([]);

      const [afterSecond] = await getDb()
        .select()
        .from(taskArtifacts)
        .where(eq(taskArtifacts.id, a.artifactId));
      expect(afterSecond?.deletedAt?.getTime()).toBe(
        originalDeletedAt?.getTime(),
      );
    });
  });

  describe("listByTask / findById (soft-delete exclusion)", () => {
    test("excludes a soft-deleted artifact from listByTask and 404s findById", async () => {
      const now = new Date("2026-08-15T00:00:00.000Z");
      const seeded = await seedArtifact({ createdAt: now });

      await getDb()
        .update(taskArtifacts)
        .set({ deletedAt: now })
        .where(
          and(
            eq(taskArtifacts.id, seeded.artifactId),
            eq(taskArtifacts.projectId, seeded.projectId),
          ),
        );

      const listed = await repo.listByTask(seeded.taskRunId);
      expect(listed).toEqual([]);

      const found = await repo.findById(seeded.artifactId);
      expect(found).toBeNull();
    });
  });
});
