import { afterEach, beforeEach, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "@scarn/api/app";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { InMemoryObjectStore } from "@/artifacts/infra/in-memory-object-store";
import { getDb } from "@/lib/db";
import {
  projects,
  taskArtifactBundles,
  taskArtifacts,
  taskRuns,
} from "@/lib/db/schema";
import { createAppContext } from "@/lib/di";
import { DrizzleArtifactBundleRepo } from "@/tasks/task-artifact/infra/drizzle-artifact-bundle-repo";
import { DrizzleArtifactRepo } from "@/tasks/task-artifact/infra/drizzle-artifact-repo";
import {
  seedTaskPrerequisites,
  seedTaskRunParent,
} from "tests/lib/db/seed-task-prerequisites";
import { createScarnTreaty } from "tests/treaty";
import { fixedTimeProvider, serialTest } from "tests/utils";

/**
 * `POST /api/internal/executions/sweep-deleted-storage` also fails artifact
 * bundles left `pending` for over a day and deletes their members. Bundles
 * are backdated far into the past and the clock sits just after, so bundles
 * other test files create (at real time) are never stale here. The date is
 * after the clock of `sweep-deleted-storage.endpoint.test.ts`, so its sweeps
 * never see these bundles as stale either.
 */
describe("sweep-deleted-storage endpoint: stale artifact bundles", () => {
  const SECRET = "test-sweep-secret-abcdef0123456789";
  const CREATED_AT = new Date("2002-03-01T12:00:00.000Z");
  const HOUR_MS = 60 * 60 * 1_000;
  const bundleRepo = new DrizzleArtifactBundleRepo();
  const artifactRepo = new DrizzleArtifactRepo();

  const seedTaskRun = async () => {
    const db = getDb();
    const projectId = createUuidV7();
    const taskRunId = createUuidV7();
    await db.insert(projects).values({
      id: projectId,
      name: "Stale bundle sweep project",
      slug: `stale-bundle-sweep-${crypto.randomUUID()}`,
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
      status: "running",
    });
    return { projectId, taskRunId };
  };

  const seedBundle = async (
    scope: { projectId: UuidV7; taskRunId: UuidV7 },
    name: string,
    store: InMemoryObjectStore,
  ) => {
    const bundle = await bundleRepo.create({
      id: createUuidV7(),
      projectId: scope.projectId,
      taskRunId: scope.taskRunId,
      name,
      fieldPath: null,
      rootPath: name,
      entryPath: "index.html",
    });
    await getDb()
      .update(taskArtifactBundles)
      .set({ createdAt: CREATED_AT })
      .where(eq(taskArtifactBundles.id, bundle.id));

    const objectKey = `artifacts/${scope.projectId}/${scope.taskRunId}/${name}/index.html`;
    await store.putObject({ key: objectKey, body: "<html></html>" });
    const member = await artifactRepo.record({
      id: createUuidV7(),
      projectId: scope.projectId,
      taskRunId: scope.taskRunId,
      relativeStorePath: `${name}/index.html`,
      objectKey,
      storeRef: `s3://bucket/${objectKey}`,
      sizeBytes: 13,
      contentType: "text/html",
      kind: "generic",
      bundleId: bundle.id,
    });
    return { bundle, member, objectKey };
  };

  const sweepAt = async (now: Date, store: InMemoryObjectStore) =>
    await createScarnTreaty(
      createApp(
        createAppContext({
          timeProvider: fixedTimeProvider(now),
          objectStore: store,
        }),
      ),
    ).api.internal.executions["sweep-deleted-storage"].post(undefined, {
      headers: { authorization: `Bearer ${SECRET}` },
    });

  const loadArtifact = async (id: UuidV7) => {
    const [row] = await getDb()
      .select()
      .from(taskArtifacts)
      .where(eq(taskArtifacts.id, id));
    return row ?? null;
  };

  let originalSecret: string | undefined;
  beforeEach(() => {
    originalSecret = process.env["RECONCILE_CRON_SECRET"];
    process.env["RECONCILE_CRON_SECRET"] = SECRET;
  });
  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env["RECONCILE_CRON_SECRET"];
    } else {
      process.env["RECONCILE_CRON_SECRET"] = originalSecret;
    }
  });

  serialTest(
    "fails a bundle pending for over a day and deletes its members",
    async () => {
      const store = new InMemoryObjectStore();
      const scope = await seedTaskRun();
      const stale = await seedBundle(scope, "stale", store);
      const ready = await seedBundle(scope, "ready", store);
      await getDb()
        .update(taskArtifactBundles)
        .set({ status: "ready" })
        .where(eq(taskArtifactBundles.id, ready.bundle.id));

      const early = await sweepAt(
        new Date(CREATED_AT.getTime() + 24 * HOUR_MS - 1),
        store,
      );
      expect(early.error).toBeNull();
      expect(early.data).toMatchObject({
        staleBundlesFailed: 0,
        staleBundleMembersDeleted: 0,
      });
      expect((await bundleRepo.findById(stale.bundle.id))?.status).toBe(
        "pending",
      );

      const now = new Date(CREATED_AT.getTime() + 25 * HOUR_MS);
      const { data, error } = await sweepAt(now, store);
      expect(error).toBeNull();
      expect(data).toMatchObject({
        staleBundlesFailed: 1,
        staleBundleMembersDeleted: 1,
      });

      expect(await bundleRepo.findById(stale.bundle.id)).toMatchObject({
        status: "failed",
        finalizedAt: now.toISOString(),
      });
      expect(await store.getObject(stale.objectKey)).toBeNull();
      expect(await loadArtifact(stale.member.id)).toMatchObject({
        deletedAt: now,
        objectKey: null,
        storeRef: null,
      });
      expect(await bundleRepo.listMembers(stale.bundle.id)).toEqual([]);

      expect((await bundleRepo.findById(ready.bundle.id))?.status).toBe(
        "ready",
      );
      expect(await store.getObject(ready.objectKey)).not.toBeNull();
      expect((await loadArtifact(ready.member.id))?.deletedAt).toBeNull();

      const again = await sweepAt(now, store);
      expect(again.data).toMatchObject({
        staleBundlesFailed: 0,
        staleBundleMembersDeleted: 0,
      });
    },
  );
});
