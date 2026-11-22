import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { concurrentTest } from "tests/utils";
import { getDb } from "@/lib/db";
import { projects, taskRuns } from "@/lib/db/schema";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { DrizzleTaskRunRepo } from "@/tasks/task-run/infra/drizzle-task-run-repo";
import { TaskEntity } from "@/tasks/task/domain/task-entity";
import { DrizzleTaskRepo } from "@/tasks/task/infra/drizzle-task-repo";
import {
  AgentTaskRunEntity,
  CodeTaskRunEntity,
  TaskRunEntity,
} from "@/tasks/task-run/domain/task-run-entity";
import {
  agentTaskInstructionColumns,
  seedTaskPrerequisites,
  seedWorkItem,
} from "tests/lib/db/seed-task-prerequisites";
// `buildExecutionDeadlineAt` is the TS side of decision 6's "two
// implementations of one rule must agree" regression guard
// (`docs/plans/claim-step-executions-batching.md`, Phase 3) — `claimBatch`
// computes the same rule in raw SQL. Importing the application-layer helper
// directly into this integration test (rather than going through the public
// API client) mirrors this repo's own established precedent for behavior
// with no convenient HTTP entry point, e.g.
// `mark-pipeline-node-run-running.test.ts`'s direct import of
// `applyPipelineNodeRunRunningTransition`.
import { buildExecutionDeadlineAt } from "@/tasks/task-run/application/task-run-claim-helpers";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const CLAIMING_USER_ID = createUuidV7();

type TaskSeedTarget = {
  projectId: UuidV7;
  workItemId: UuidV7;
};

const seedProjectAndTaskPrerequisites = async (
  label: string,
): Promise<TaskSeedTarget> => {
  const db = getDb();
  const projectId = createUuidV7();

  await db.insert(projects).values({
    id: projectId,
    name: `task-repo test project ${label}`,
    slug: `task-repo-${label}-${crypto.randomUUID()}`,
    gitUrl: "https://github.com/example/test-project.git",
    createdByUserId: createUuidV7(),
    orgId: createUuidV7(),
  });

  const { workItemId } = await seedTaskPrerequisites(projectId, db);

  return { projectId, workItemId };
};

const taskRepo = new DrizzleTaskRepo();

const buildQueuedTask = async (
  target: TaskSeedTarget,
  overrides?: {
    workItemId?: UuidV7;
    executionTimeoutSeconds?: number;
    entrypointJson?: { sourceFile: string };
  },
) => {
  const task = await taskRepo.create(
    TaskEntity.create({
      projectId: target.projectId,
      workItemId: overrides?.workItemId ?? target.workItemId,
      ...(overrides?.entrypointJson
        ? { kind: "code" as const, entrypointJson: overrides.entrypointJson }
        : agentTaskInstructionColumns),
      status: "queued",
      inputJson: {},
      executionTimeoutSeconds: overrides?.executionTimeoutSeconds ?? null,
      createdAt: NOW,
    }),
  );
  return task.newRun({
    number: 1,
    reason: "initial",
    status: "queued",
    now: NOW,
  });
};

/**
 * Direct repo coverage for `DrizzleTaskRunRepo.save`/`saveMany`'s
 * `reload` parameter (`docs/plans/claim-step-executions-batching.md`, Phase
 * 1, decision 2). Driven straight through the repo, no HTTP route needed —
 * mirrors `drizzle-pipeline-run-repo.test.ts`'s style for aggregates whose
 * behavior isn't fully reachable through the public API surface.
 */
describe("DrizzleTaskRunRepo save/saveMany reload option", () => {
  const repo = new DrizzleTaskRunRepo({
    now: () => NOW,
    nowIso: () => NOW.toISOString(),
  });

  const buildQueuedEntity = async (target: TaskSeedTarget) =>
    TaskRunEntity.rehydrate({
      ...(await buildQueuedTask(target)).toJSON(),
      id: createUuidV7(),
      inputJson: { ok: true },
    });

  concurrentTest(
    "save(entity, dbExecutor, false) persists identically to the default reload but returns the input, not a reload",
    async () => {
      const target = await seedProjectAndTaskPrerequisites("save-reload-false");
      const created = await repo.create(await buildQueuedEntity(target));

      const running = created.markRunning(NOW);
      const saved = await repo.save(running, undefined, false);

      // `false` mode hands back the *input* argument unchanged, not a fresh
      // reload — same object identity.
      expect(saved).toBe(running);

      // The write itself happened exactly as the default-reload path would:
      // a separate `load()` proves the row was actually persisted running.
      const reloaded = await repo.load(created.id);
      expect(reloaded?.status).toBe("running");
      expect(reloaded?.startedAt?.toISOString()).toBe(NOW.toISOString());
    },
  );

  concurrentTest(
    "save(entity, dbExecutor) (default reload) persists the same row a reload: false save would, but returns a freshly-loaded entity",
    async () => {
      const target = await seedProjectAndTaskPrerequisites("save-reload-true");
      const created = await repo.create(await buildQueuedEntity(target));

      const running = created.markRunning(NOW);
      const saved = await repo.save(running);

      // Default mode returns a reloaded entity — not the same object
      // reference as the input, even though the values agree.
      expect(saved).not.toBe(running);
      expect(saved.status).toBe("running");
      expect(saved.startedAt?.toISOString()).toBe(NOW.toISOString());
    },
  );

  concurrentTest(
    "saveMany(entities, dbExecutor, false) persists but returns []",
    async () => {
      const target = await seedProjectAndTaskPrerequisites(
        "save-many-reload-false",
      );
      const createdA = await repo.create(await buildQueuedEntity(target));
      const createdB = await repo.create(await buildQueuedEntity(target));

      const result = await repo.saveMany(
        [createdA.markRunning(NOW), createdB.markRunning(NOW)],
        undefined,
        false,
      );

      expect(result).toEqual([]);

      const reloadedA = await repo.load(createdA.id);
      const reloadedB = await repo.load(createdB.id);
      expect(reloadedA?.status).toBe("running");
      expect(reloadedB?.status).toBe("running");
    },
  );

  concurrentTest(
    "saveMany(entities, dbExecutor) (default reload) returns the persisted, reloaded entities",
    async () => {
      const target = await seedProjectAndTaskPrerequisites(
        "save-many-reload-true",
      );
      const createdA = await repo.create(await buildQueuedEntity(target));

      const result = await repo.saveMany([createdA.markRunning(NOW)]);

      expect(result).toHaveLength(1);
      expect(result[0]?.status).toBe("running");
    },
  );
});

describe("DrizzleTaskRunRepo per-kind round trip", () => {
  const repo = new DrizzleTaskRunRepo({
    now: () => NOW,
    nowIso: () => NOW.toISOString(),
  });

  concurrentTest(
    "an agent task reloads as an AgentTaskRunEntity with its prompt",
    async () => {
      const target = await seedProjectAndTaskPrerequisites("round-trip-agent");
      const created = await repo.create(await buildQueuedTask(target));

      const reloaded = await repo.load(created.id);
      expect(reloaded).toBeInstanceOf(AgentTaskRunEntity);
      expect(reloaded?.kind === "agent" && reloaded.prompt).toBe(
        "Return a result payload.",
      );
    },
  );

  concurrentTest(
    "a code task reloads as a CodeTaskRunEntity with its entrypoint",
    async () => {
      const target = await seedProjectAndTaskPrerequisites("round-trip-code");
      const created = await repo.create(
        await buildQueuedTask(target, {
          entrypointJson: { sourceFile: "steps/triage.ts" },
        }),
      );

      const reloaded = await repo.load(created.id);
      expect(reloaded).toBeInstanceOf(CodeTaskRunEntity);
      expect(reloaded?.kind === "code" && reloaded.entrypointJson).toEqual({
        sourceFile: "steps/triage.ts",
      });
    },
  );
});

/**
 * Direct repo coverage for `DrizzleTaskRunRepo.claimBatch`
 * (`docs/plans/claim-step-executions-batching.md`, Phase 3) — the one
 * atomic `UPDATE ... FROM (... FOR UPDATE SKIP LOCKED) ... RETURNING`
 * statement replacing the old per-candidate `claim()` loop. The
 * `batchSize`-vs-available-rows and `workItemId`-scoping scenarios are
 * covered end-to-end through `POST /tasks/claims`
 * (`task.claims.test.ts`); the two scenarios here — the SQL/TS
 * deadline-computation agreement and the deadline-already-passed exclusion —
 * need direct control over a row's `executionDeadlineAt` before claiming,
 * which the HTTP surface has no way to set (it's only ever written by a
 * claim itself), so they're driven straight through the repo instead,
 * matching this file's own established style for that situation.
 */
describe("DrizzleTaskRunRepo claimBatch", () => {
  const repo = new DrizzleTaskRunRepo({
    now: () => NOW,
    nowIso: () => NOW.toISOString(),
  });

  concurrentTest(
    "computes executionDeadlineAt for a claimed row exactly as buildExecutionDeadlineAt does for the same inputs (decision 6 regression guard)",
    async () => {
      const target = await seedProjectAndTaskPrerequisites(
        "claim-batch-deadline-agreement",
      );
      const queued = await repo.create(
        await buildQueuedTask(target, { executionTimeoutSeconds: 120 }),
      );
      // The queued row has no pre-existing `executionDeadlineAt` and no
      // `startedAt` — exactly the branch of `buildExecutionDeadlineAt` that
      // computes a fresh deadline from `now` + `executionTimeoutSeconds`.
      const expectedDeadlineAt = buildExecutionDeadlineAt(queued, NOW);

      const [claimed] = await repo.claimBatch(
        target.projectId,
        1,
        NOW,
        "worker-deadline-agreement",
        CLAIMING_USER_ID,
        30,
      );

      expect(claimed?.executionDeadlineAt?.toISOString()).toBe(
        expectedDeadlineAt?.toISOString(),
      );
      expect(claimed?.claimedByUserId).toBe(CLAIMING_USER_ID);
    },
  );

  concurrentTest(
    "never claims a row whose executionDeadlineAt has already passed",
    async () => {
      const target = await seedProjectAndTaskPrerequisites(
        "claim-batch-deadline-passed",
      );
      const queued = await repo.create(await buildQueuedTask(target));
      // No HTTP path can produce a `queued` row with an already-passed
      // `executionDeadlineAt` — it is only ever set by a claim. Writing it
      // directly here isolates `claimBatch`'s own `WHERE` exclusion
      // (decision 7) from the separate, application-layer timed-out
      // detection query.
      await getDb()
        .update(taskRuns)
        .set({ executionDeadlineAt: new Date(NOW.getTime() - 1_000) })
        .where(eq(taskRuns.id, queued.id));

      const claimed = await repo.claimBatch(
        target.projectId,
        5,
        NOW,
        "worker-deadline-passed",
        CLAIMING_USER_ID,
        30,
      );

      expect(claimed).toHaveLength(0);
      const reloaded = await repo.load(queued.id);
      expect(reloaded?.persistedStatus).toBe("queued");
      expect(reloaded?.claimedBy).toBeNull();
    },
  );

  concurrentTest(
    "scopes a workItemId claim by the Task's own work_item_id, including standalone Tasks",
    async () => {
      const target = await seedProjectAndTaskPrerequisites(
        "claim-batch-work-item-scope",
      );
      const otherWorkItemId = await seedWorkItem(target.projectId);
      const matching = await repo.create(await buildQueuedTask(target));
      const other = await repo.create(
        await buildQueuedTask(target, { workItemId: otherWorkItemId }),
      );

      const claimable = await repo.loadClaimableByProjectId(
        target.projectId,
        10,
        NOW,
        undefined,
        target.workItemId,
      );
      expect(claimable.map((task) => task.id)).toEqual([matching.id]);

      const claimed = await repo.claimBatch(
        target.projectId,
        10,
        NOW,
        "worker-work-item-scope",
        CLAIMING_USER_ID,
        30,
        undefined,
        target.workItemId,
      );
      expect(claimed.map((task) => task.id)).toEqual([matching.id]);

      const untouched = await repo.load(other.id);
      expect(untouched?.persistedStatus).toBe("queued");
    },
  );

  concurrentTest("never claims a yielded Task", async () => {
    const target = await seedProjectAndTaskPrerequisites("claim-batch-yielded");
    const yielded = await repo.create(await buildQueuedTask(target));
    await getDb()
      .update(taskRuns)
      .set({ status: "yielded" })
      .where(eq(taskRuns.id, yielded.id));

    const claimable = await repo.loadClaimableByProjectId(
      target.projectId,
      10,
      NOW,
    );
    expect(claimable).toHaveLength(0);

    const claimed = await repo.claimBatch(
      target.projectId,
      10,
      NOW,
      "worker-yielded",
      CLAIMING_USER_ID,
      30,
    );
    expect(claimed).toHaveLength(0);

    const reloaded = await repo.load(yielded.id);
    expect(reloaded?.persistedStatus).toBe("yielded");
    expect(reloaded?.claimedBy).toBeNull();
  });
});
