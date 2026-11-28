import { eq } from "drizzle-orm";
import { describe, expect, test } from "bun:test";
import { getDb } from "@/lib/db";
import {
  projects,
  taskArtifactBundles,
  taskArtifacts,
  taskRuns,
} from "@/lib/db/schema";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { ResourceConflictError } from "@/lib/errors";
import { DrizzleArtifactBundleRepo } from "@/tasks/task-artifact/infra/drizzle-artifact-bundle-repo";
import { DrizzleArtifactRepo } from "@/tasks/task-artifact/infra/drizzle-artifact-repo";
import {
  seedTaskRunParent,
  seedTaskPrerequisites,
} from "tests/lib/db/seed-task-prerequisites";

/**
 * Integration coverage for `DrizzleArtifactBundleRepo`. Rows are seeded via
 * Drizzle (project -> work item -> task run), then bundles and member
 * artifacts are written through the repos themselves.
 */
describe("DrizzleArtifactBundleRepo", () => {
  const repo = new DrizzleArtifactBundleRepo();
  const artifactRepo = new DrizzleArtifactRepo();

  const seedTaskRun = async (): Promise<{
    projectId: UuidV7;
    taskRunId: UuidV7;
  }> => {
    const db = getDb();
    const projectId = createUuidV7();
    const taskRunId = createUuidV7();

    await db.insert(projects).values({
      id: projectId,
      name: "Artifact bundle repo test project",
      slug: `artifact-bundle-repo-${crypto.randomUUID()}`,
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

  const createBundle = (
    scope: { projectId: UuidV7; taskRunId: UuidV7 },
    overrides: Partial<{ name: string; fieldPath: string | null }> = {},
  ) =>
    repo.create({
      id: createUuidV7(),
      projectId: scope.projectId,
      taskRunId: scope.taskRunId,
      name: overrides.name ?? "report",
      fieldPath: overrides.fieldPath ?? null,
      rootPath: "out/report",
      entryPath: "index.html",
    });

  const recordMember = (
    scope: { projectId: UuidV7; taskRunId: UuidV7 },
    relativeStorePath: string,
    bundleId: UuidV7 | null,
  ) => {
    const objectKey = `artifacts/${scope.projectId}/${scope.taskRunId}/${relativeStorePath}`;
    return artifactRepo.record({
      id: createUuidV7(),
      projectId: scope.projectId,
      taskRunId: scope.taskRunId,
      relativeStorePath,
      objectKey,
      storeRef: `s3://bucket/${objectKey}`,
      sizeBytes: 100,
      contentType: "text/html",
      kind: "generic",
      bundleId,
    });
  };

  test("create inserts a pending bundle and findById loads it", async () => {
    const scope = await seedTaskRun();
    const created = await createBundle(scope, { fieldPath: "report" });

    expect(created).toMatchObject({
      projectId: scope.projectId,
      taskRunId: scope.taskRunId,
      name: "report",
      fieldPath: "report",
      rootPath: "out/report",
      entryPath: "index.html",
      status: "pending",
      fileCount: null,
      sizeBytes: null,
      finalizedAt: null,
      deletedAt: null,
    });
    expect(await repo.findById(created.id)).toEqual(created);
    expect(await repo.findById(createUuidV7())).toBeNull();
  });

  test("create rejects a duplicate name in the same task run", async () => {
    const scope = await seedTaskRun();
    await createBundle(scope);

    let error: unknown = null;
    try {
      await createBundle(scope);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ResourceConflictError);

    const other = await seedTaskRun();
    expect(await createBundle(other)).toMatchObject({ name: "report" });
  });

  test("finalize marks a pending bundle ready once", async () => {
    const scope = await seedTaskRun();
    const bundle = await createBundle(scope);
    const finalizedAt = new Date("2026-11-26T12:00:00.000Z");

    const ready = await repo.finalize(
      bundle.id,
      { status: "ready", fileCount: 3, sizeBytes: 4096 },
      finalizedAt,
    );
    expect(ready).toMatchObject({
      status: "ready",
      fileCount: 3,
      sizeBytes: 4096,
      finalizedAt: finalizedAt.toISOString(),
    });

    expect(
      await repo.finalize(bundle.id, { status: "failed" }, new Date()),
    ).toBeNull();
    expect((await repo.findById(bundle.id))?.status).toBe("ready");
  });

  test("finalize can mark a bundle failed", async () => {
    const scope = await seedTaskRun();
    const bundle = await createBundle(scope);

    const failed = await repo.finalize(
      bundle.id,
      { status: "failed" },
      new Date(),
    );
    expect(failed).toMatchObject({
      status: "failed",
      fileCount: null,
      sizeBytes: null,
    });
  });

  test("listByTask returns the run's non-deleted bundles, newest first", async () => {
    const scope = await seedTaskRun();
    const first = await createBundle(scope, { name: "first" });
    const second = await createBundle(scope, { name: "second" });
    const deleted = await createBundle(scope, { name: "deleted" });
    await getDb()
      .update(taskArtifactBundles)
      .set({ deletedAt: new Date() })
      .where(eq(taskArtifactBundles.id, deleted.id));
    await createBundle(await seedTaskRun(), { name: "other-run" });

    const listed = await repo.listByTask(scope.taskRunId);
    expect(listed.map((bundle) => bundle.id)).toEqual([second.id, first.id]);
    expect(await repo.findById(deleted.id)).toBeNull();
  });

  test("findMember resolves a root-relative path to the bundle's member", async () => {
    const scope = await seedTaskRun();
    const bundle = await createBundle(scope);
    const otherBundle = await createBundle(scope, { name: "other" });
    const member = await recordMember(
      scope,
      "out/report/assets/app.js",
      bundle.id,
    );
    await recordMember(scope, "out/report/index.html", otherBundle.id);
    await recordMember(scope, "out/report/loose.txt", null);

    expect((await repo.findMember(bundle.id, "./assets//app.js"))?.id).toBe(
      member.id,
    );
    expect(await repo.findMember(bundle.id, "index.html")).toBeNull();
    expect(await repo.findMember(bundle.id, "loose.txt")).toBeNull();
    expect(
      await repo.findMember(bundle.id, "out/report/assets/app.js"),
    ).toBeNull();
    expect(await repo.findMember(createUuidV7(), "assets/app.js")).toBeNull();

    await getDb()
      .update(taskArtifacts)
      .set({ deletedAt: new Date() })
      .where(eq(taskArtifacts.id, member.id));
    expect(await repo.findMember(bundle.id, "assets/app.js")).toBeNull();
  });

  test("listStalePending returns pending bundles created before the cutoff", async () => {
    const scope = await seedTaskRun();
    const db = getDb();
    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000);

    const stale = await createBundle(scope, { name: "stale" });
    const staleReady = await createBundle(scope, { name: "stale-ready" });
    const fresh = await createBundle(scope, { name: "fresh" });
    await db
      .update(taskArtifactBundles)
      .set({ createdAt: old })
      .where(eq(taskArtifactBundles.id, stale.id));
    await db
      .update(taskArtifactBundles)
      .set({ createdAt: old, status: "ready" })
      .where(eq(taskArtifactBundles.id, staleReady.id));

    const ids = (await repo.listStalePending(cutoff, 10_000)).map(
      (bundle) => bundle.id,
    );
    expect(ids).toContain(stale.id);
    expect(ids).not.toContain(staleReady.id);
    expect(ids).not.toContain(fresh.id);
  });

  test("members carry their bundleId; findManyByIds skips deleted and missing bundles", async () => {
    const scope = await seedTaskRun();
    const bundle = await createBundle(scope);
    const deleted = await createBundle(scope, { name: "deleted" });
    await getDb()
      .update(taskArtifactBundles)
      .set({ deletedAt: new Date() })
      .where(eq(taskArtifactBundles.id, deleted.id));

    const member = await recordMember(
      scope,
      "out/report/index.html",
      bundle.id,
    );
    const loose = await recordMember(scope, "loose.txt", null);
    expect(member.bundleId).toBe(bundle.id);
    expect(loose.bundleId).toBeNull();
    expect(
      (await artifactRepo.listByTask(scope.taskRunId)).map((artifact) => [
        artifact.id,
        artifact.bundleId,
      ]),
    ).toContainEqual([member.id, bundle.id]);

    const found = await repo.findManyByIds([
      bundle.id,
      deleted.id,
      createUuidV7(),
    ]);
    expect(found.map((row) => row.id)).toEqual([bundle.id]);
    expect(await repo.findManyByIds([])).toEqual([]);
  });

  test("clearExpiredArtifacts expires bundles created on or before the retention cutoff", async () => {
    const scope = await seedTaskRun();
    const now = new Date();
    const retentionDays = 30;
    const old = new Date(
      now.getTime() - (retentionDays + 1) * 24 * 60 * 60 * 1_000,
    );

    const expiring = await createBundle(scope, { name: "expiring" });
    const fresh = await createBundle(scope, { name: "fresh" });
    await getDb()
      .update(taskArtifactBundles)
      .set({ createdAt: old })
      .where(eq(taskArtifactBundles.id, expiring.id));

    await artifactRepo.clearExpiredArtifacts(now, retentionDays);

    expect((await repo.findById(expiring.id))?.expiredAt).toBe(
      now.toISOString(),
    );
    expect((await repo.findById(fresh.id))?.expiredAt).toBeNull();

    const later = new Date(now.getTime() + 60_000);
    await artifactRepo.clearExpiredArtifacts(later, retentionDays);
    expect((await repo.findById(expiring.id))?.expiredAt).toBe(
      now.toISOString(),
    );
  });
});
