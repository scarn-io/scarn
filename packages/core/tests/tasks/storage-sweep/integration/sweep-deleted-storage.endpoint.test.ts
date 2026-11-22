import { afterEach, beforeEach, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "@scarn/api/app";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import type { ObjectStore } from "@/artifacts/object-store";
import { InMemoryObjectStore } from "@/artifacts/infra/in-memory-object-store";
import { getDb } from "@/lib/db";
import { projects, storageSweeps } from "@/lib/db/schema";
import { createAppContext } from "@/lib/di";
import { scheduleStorageSweeps } from "@/tasks/storage-sweep/application/schedule-storage-sweeps";
import { DrizzleStorageSweepRepo } from "@/tasks/storage-sweep/infra/drizzle-storage-sweep-repo";
import { createScarnTreaty } from "tests/treaty";
import { fixedTimeProvider, serialTest } from "tests/utils";

/**
 * `POST /api/internal/executions/sweep-deleted-storage`: the scheduled second
 * pass of the deletion contract. Service-authenticated (shared bearer token),
 * runs against real Postgres with an injected object store and clock.
 *
 * The database is shared with concurrently running test files, some of which
 * schedule real sweeps (deleting a conversation does). The clock sits in the
 * past so those rows are never due or overdue here, and this file only
 * clears and counts the rows it created (`created_at = DELETED_AT`).
 */
describe("sweep-deleted-storage endpoint", () => {
  const SECRET = "test-sweep-secret-abcdef0123456789";
  const DELETED_AT = new Date("2001-06-15T12:00:00.000Z");
  const HOUR_MS = 60 * 60 * 1_000;
  const at = (offsetMs: number) => new Date(DELETED_AT.getTime() + offsetMs);
  const repo = new DrizzleStorageSweepRepo();

  const createClient = (input: {
    now: Date;
    objectStore: ObjectStore | null;
  }) =>
    createScarnTreaty(
      createApp(
        createAppContext({
          timeProvider: fixedTimeProvider(input.now),
          objectStore: input.objectStore,
        }),
      ),
    );

  const sweep = async (
    client: ReturnType<typeof createClient>,
    authorization = `Bearer ${SECRET}`,
  ) =>
    await client.api.internal.executions["sweep-deleted-storage"].post(
      undefined,
      { headers: { authorization } },
    );

  const scheduleRun = async (
    run: { projectId: UuidV7; taskRunId: UuidV7 } = {
      projectId: createUuidV7(),
      taskRunId: createUuidV7(),
    },
  ) => {
    await repo.schedule(
      [run],
      { notBefore: at(HOUR_MS), createdAt: DELETED_AT },
      getDb(),
    );
    return run;
  };

  const runObjectKeys = (run: { projectId: UuidV7; taskRunId: UuidV7 }) => [
    `tasks/${run.taskRunId}/session.json`,
    `step-executions/${run.taskRunId}/log.ndjson`,
    `artifacts/${run.projectId}/${run.taskRunId}/report.md`,
  ];

  const seedObjects = async (
    store: ObjectStore,
    run: { projectId: UuidV7; taskRunId: UuidV7 },
  ) => {
    await Promise.all(
      runObjectKeys(run).map(
        async (key) => await store.putObject({ key, body: "x" }),
      ),
    );
  };

  const loadSweep = async (taskRunId: UuidV7) => {
    const [row] = await getDb()
      .select()
      .from(storageSweeps)
      .where(eq(storageSweeps.taskRunId, taskRunId));
    return row ?? null;
  };

  const ownSweeps = eq(storageSweeps.createdAt, DELETED_AT);

  let originalSecret: string | undefined;
  beforeEach(async () => {
    originalSecret = process.env["RECONCILE_CRON_SECRET"];
    process.env["RECONCILE_CRON_SECRET"] = SECRET;
    await getDb().delete(storageSweeps).where(ownSweeps);
  });
  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env["RECONCILE_CRON_SECRET"];
    } else {
      process.env["RECONCILE_CRON_SECRET"] = originalSecret;
    }
  });

  serialTest(
    "schedules sweeps an hour out, only when the caller's transaction commits",
    async () => {
      const deps = {
        storageSweepRepo: repo,
        timeProvider: fixedTimeProvider(DELETED_AT),
      };
      const committed = {
        projectId: createUuidV7(),
        taskRunId: createUuidV7(),
      };
      const rolledBack = {
        projectId: createUuidV7(),
        taskRunId: createUuidV7(),
      };

      await getDb().transaction(async (tx) => {
        await scheduleStorageSweeps([committed], deps, tx);
      });
      await getDb()
        .transaction(async (tx) => {
          await scheduleStorageSweeps([rolledBack], deps, tx);
          throw new Error("rollback");
        })
        .catch(() => undefined);

      expect(await loadSweep(committed.taskRunId)).toMatchObject({
        projectId: committed.projectId,
        notBefore: at(HOUR_MS),
        attempts: 0,
        lastError: null,
      });
      expect(await loadSweep(rolledBack.taskRunId)).toBeNull();
    },
  );

  serialTest("rejects a request without the service token", async () => {
    const client = createClient({
      now: DELETED_AT,
      objectStore: new InMemoryObjectStore(),
    });
    const missing =
      await client.api.internal.executions["sweep-deleted-storage"].post();
    expect(missing.status).toBe(401);
    const wrong = await sweep(client, "Bearer wrong");
    expect(wrong.status).toBe(401);
  });

  serialTest("leaves a sweep that is not yet due untouched", async () => {
    const store = new InMemoryObjectStore();
    const run = await scheduleRun();
    await seedObjects(store, run);

    const { data, error } = await sweep(
      createClient({ now: at(HOUR_MS - 1), objectStore: store }),
    );

    expect(error).toBeNull();
    expect(data).toEqual({ swept: 0, failed: 0, overdue: 0 });
    expect(await loadSweep(run.taskRunId)).toMatchObject({
      attempts: 0,
      notBefore: at(HOUR_MS),
    });
    for (const key of runObjectKeys(run)) {
      expect(await store.getObject(key)).not.toBeNull();
    }
  });

  serialTest(
    "deletes a due sweep's three prefixes and removes the row",
    async () => {
      const store = new InMemoryObjectStore();
      const run = await scheduleRun();
      const otherRun = { projectId: run.projectId, taskRunId: createUuidV7() };
      await seedObjects(store, run);
      await seedObjects(store, otherRun);

      const { data, error } = await sweep(
        createClient({ now: at(HOUR_MS), objectStore: store }),
      );

      expect(error).toBeNull();
      expect(data).toEqual({ swept: 1, failed: 0, overdue: 0 });
      expect(await loadSweep(run.taskRunId)).toBeNull();
      for (const key of runObjectKeys(run)) {
        expect(await store.getObject(key)).toBeNull();
      }
      for (const key of runObjectKeys(otherRun)) {
        expect(await store.getObject(key)).not.toBeNull();
      }
    },
  );

  serialTest(
    "an upload landing after the delete is removed once not_before passes",
    async () => {
      const store = new InMemoryObjectStore();
      const run = await scheduleRun();

      const early = await sweep(
        createClient({ now: at(HOUR_MS - 1), objectStore: store }),
      );
      expect(early.data).toEqual({ swept: 0, failed: 0, overdue: 0 });

      await seedObjects(store, run);
      const due = await sweep(
        createClient({ now: at(HOUR_MS), objectStore: store }),
      );

      expect(due.data).toEqual({ swept: 1, failed: 0, overdue: 0 });
      for (const key of runObjectKeys(run)) {
        expect(await store.getObject(key)).toBeNull();
      }
      expect(await loadSweep(run.taskRunId)).toBeNull();
    },
  );

  serialTest(
    "records a failed sweep and retries it after a backoff",
    async () => {
      const run = await scheduleRun();
      const failingStore: ObjectStore = {
        putObject: () => Promise.resolve({ sizeBytes: 0 }),
        getObject: () => Promise.resolve(null),
        getPresignedGetUrl: () => Promise.resolve(null),
        getPresignedPutUrl: () => Promise.resolve(null),
        deleteObject: () => Promise.resolve(),
        deletePrefix: () => Promise.reject(new Error("simulated S3 outage")),
      };

      const first = await sweep(
        createClient({ now: at(HOUR_MS), objectStore: failingStore }),
      );
      expect(first.data).toEqual({ swept: 0, failed: 1, overdue: 0 });
      expect(await loadSweep(run.taskRunId)).toMatchObject({
        attempts: 1,
        lastError: "Error: simulated S3 outage",
        notBefore: at(2 * HOUR_MS),
      });

      const second = await sweep(
        createClient({ now: at(2 * HOUR_MS), objectStore: failingStore }),
      );
      expect(second.data).toEqual({ swept: 0, failed: 1, overdue: 0 });
      expect(await loadSweep(run.taskRunId)).toMatchObject({
        attempts: 2,
        notBefore: at(4 * HOUR_MS),
      });

      const store = new InMemoryObjectStore();
      await seedObjects(store, run);
      const third = await sweep(
        createClient({ now: at(4 * HOUR_MS), objectStore: store }),
      );
      expect(third.data).toEqual({ swept: 1, failed: 0, overdue: 0 });
      expect(await loadSweep(run.taskRunId)).toBeNull();
    },
  );

  serialTest(
    "does not complete a sweep when object storage is not configured",
    async () => {
      const run = await scheduleRun();

      const { data } = await sweep(
        createClient({ now: at(HOUR_MS), objectStore: null }),
      );

      expect(data).toEqual({ swept: 0, failed: 1, overdue: 0 });
      expect(await loadSweep(run.taskRunId)).toMatchObject({
        attempts: 1,
        lastError: "Error: Object storage is not configured",
      });
    },
  );

  serialTest("reports sweeps older than a day as overdue", async () => {
    const run = await scheduleRun();

    const { data } = await sweep(
      createClient({ now: at(25 * HOUR_MS), objectStore: null }),
    );

    expect(data).toEqual({ swept: 0, failed: 1, overdue: 1 });
    expect(await loadSweep(run.taskRunId)).not.toBeNull();
  });

  serialTest(
    "concurrent sweepers process each due sweep exactly once",
    async () => {
      const store = new InMemoryObjectStore();
      const deletedPrefixes: string[] = [];
      const countingStore: ObjectStore = {
        putObject: async (input) => await store.putObject(input),
        getObject: async (key) => await store.getObject(key),
        getPresignedGetUrl: () => Promise.resolve(null),
        getPresignedPutUrl: () => Promise.resolve(null),
        deleteObject: async (key) => {
          await store.deleteObject(key);
        },
        deletePrefix: async (prefix) => {
          deletedPrefixes.push(prefix);
          await new Promise<void>((resolve) => {
            queueMicrotask(resolve);
          });
          return await store.deletePrefix(prefix);
        },
      };
      const runs = await Promise.all(
        Array.from({ length: 20 }, async () => await scheduleRun()),
      );

      const results = await Promise.all(
        [1, 2, 3].map(
          async () =>
            await sweep(
              createClient({ now: at(HOUR_MS), objectStore: countingStore }),
            ),
        ),
      );

      const swept = results.reduce(
        (total, result) => total + (result.data?.swept ?? 0),
        0,
      );
      expect(swept).toBe(runs.length);
      expect(deletedPrefixes).toHaveLength(runs.length * 3);
      expect(new Set(deletedPrefixes).size).toBe(runs.length * 3);
      const remaining = await getDb()
        .select()
        .from(storageSweeps)
        .where(ownSweeps);
      expect(remaining).toHaveLength(0);
    },
  );

  serialTest(
    "concurrent small-batch claims never hand out the same sweep twice",
    async () => {
      const runs = await Promise.all(
        Array.from({ length: 30 }, async () => await scheduleRun()),
      );
      const now = at(HOUR_MS);
      const leaseUntil = at(HOUR_MS + 15 * 60 * 1_000);

      const claims = await Promise.all(
        Array.from(
          { length: 12 },
          async () => await repo.claimDue({ now, leaseUntil, limit: 3 }),
        ),
      );

      const claimedIds = claims.flat().map((claimed) => claimed.id);
      expect(new Set(claimedIds).size).toBe(claimedIds.length);
      const leftover = await repo.claimDue({ now, leaseUntil, limit: 100 });
      const allIds = [...claimedIds, ...leftover.map((claimed) => claimed.id)];
      expect(new Set(allIds).size).toBe(runs.length);
      expect(allIds).toHaveLength(runs.length);
    },
  );

  serialTest("a sweep survives its project being deleted", async () => {
    const db = getDb();
    const projectId = createUuidV7();
    await db.insert(projects).values({
      id: projectId,
      name: "Storage sweep project",
      slug: `storage-sweep-${crypto.randomUUID()}`,
      gitUrl: "https://github.com/example/test-project.git",
      createdByUserId: createUuidV7(),
      orgId: createUuidV7(),
    });
    const run = await scheduleRun({ projectId, taskRunId: createUuidV7() });
    const store = new InMemoryObjectStore();
    await seedObjects(store, run);

    await db.delete(projects).where(eq(projects.id, projectId));
    expect(await loadSweep(run.taskRunId)).not.toBeNull();

    const { data } = await sweep(
      createClient({ now: at(HOUR_MS), objectStore: store }),
    );
    expect(data).toEqual({ swept: 1, failed: 0, overdue: 0 });
    for (const key of runObjectKeys(run)) {
      expect(await store.getObject(key)).toBeNull();
    }
  });
});
