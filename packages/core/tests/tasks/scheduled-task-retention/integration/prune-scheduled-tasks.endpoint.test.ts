import { afterAll, afterEach, beforeEach, describe, expect } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "@scarn/api/app";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { InMemoryObjectStore } from "@/artifacts/infra/in-memory-object-store";
import { getDb } from "@/lib/db";
import {
  automations,
  projects,
  storageSweeps,
  taskRuns,
  tasks,
} from "@/lib/db/schema";
import { createAppContext } from "@/lib/di";
import { AutomationScheduleEntity } from "@/pipeline-definitions/automation/domain/automation-schedule-entity";
import { TaskEntity, type TaskStatus } from "@/tasks/task/domain/task-entity";
import {
  agentTaskInstructionColumns,
  seedTaskPrerequisites,
} from "tests/lib/db/seed-task-prerequisites";
import { createScarnTreaty } from "tests/treaty";
import { fixedTimeProvider, serialTest } from "tests/utils";

/**
 * `POST /api/internal/executions/prune-scheduled-tasks`: the daily job that
 * deletes a schedule's old, ended Tasks. Service-authenticated, runs against
 * real Postgres.
 *
 * The database is shared with concurrently running test files. The clock sits
 * far in the future so the sweeps this file schedules are never due for the
 * sweep tests, and assertions only read this file's own schedules and rows.
 */
describe("prune-scheduled-tasks endpoint", () => {
  const SECRET = "test-prune-secret-abcdef0123456789";
  const NOW = new Date("2090-01-01T12:00:00.000Z");
  const MINUTE_MS = 60 * 1_000;
  const DAY_MS = 24 * 60 * MINUTE_MS;

  const appContext = createAppContext({
    timeProvider: fixedTimeProvider(NOW),
    objectStore: new InMemoryObjectStore(),
  });
  const { taskRepo, taskRunRepo, automationScheduleRepo } = appContext;
  const client = createScarnTreaty(createApp(appContext));

  const prune = async (authorization = `Bearer ${SECRET}`) =>
    await client.api.internal.executions["prune-scheduled-tasks"].post(
      undefined,
      { headers: { authorization } },
    );

  const seedProject = async (): Promise<UuidV7> => {
    const projectId = createUuidV7();
    await getDb()
      .insert(projects)
      .values({
        id: projectId,
        name: "Prune scheduled tasks project",
        slug: `prune-scheduled-${crypto.randomUUID()}`,
        gitUrl: "https://github.com/example/test-project.git",
        createdByUserId: createUuidV7(),
        orgId: createUuidV7(),
      });
    return projectId;
  };

  const seedSchedule = async (projectId: UuidV7): Promise<UuidV7> => {
    const automationId = createUuidV7();
    await getDb()
      .insert(automations)
      .values({
        id: automationId,
        projectId,
        key: `scheduled-${crypto.randomUUID()}`,
        scope: "project",
        enabled: true,
      });
    const schedule = await automationScheduleRepo.insert(
      AutomationScheduleEntity.create(
        automationId,
        {
          key: "poll",
          cron: "* * * * *",
          timezone: "UTC",
          concurrency: { max: 1, waiting: 0 },
        },
        NOW,
      ),
    );
    return schedule.id;
  };

  const seedScheduledTask = async (input: {
    projectId: UuidV7;
    scheduleId: UuidV7;
    status: TaskStatus;
    scheduledFor: Date;
    previousTaskId?: UuidV7;
  }) => {
    const task = await taskRepo.create(
      TaskEntity.create({
        projectId: input.projectId,
        workItemId: null,
        ...agentTaskInstructionColumns,
        status: input.status,
        startedByScheduleId: input.scheduleId,
        scheduledFor: input.scheduledFor,
        previousTaskId: input.previousTaskId ?? null,
        createdAt: input.scheduledFor,
      }),
    );
    const run = await taskRunRepo.create(
      task.newRun({
        number: 1,
        reason: "initial",
        status: "queued",
        now: input.scheduledFor,
      }),
    );
    return { task, runId: run.id };
  };

  const existingTaskIds = async (ids: UuidV7[]) =>
    new Set(
      (
        await getDb()
          .select({ id: tasks.id })
          .from(tasks)
          .where(inArray(tasks.id, ids))
      ).map((row) => row.id),
    );

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
  afterAll(async () => {
    await getDb().delete(storageSweeps).where(eq(storageSweeps.createdAt, NOW));
  });

  serialTest("rejects a request without the service token", async () => {
    const missing =
      await client.api.internal.executions["prune-scheduled-tasks"].post();
    expect(missing.status).toBe(401);
    const wrong = await prune("Bearer wrong");
    expect(wrong.status).toBe(401);
  });

  serialTest(
    "deletes a schedule's old ended Tasks and keeps what the rule keeps",
    async () => {
      const projectId = await seedProject();
      const scheduleId = await seedSchedule(projectId);
      const old = (i: number) =>
        new Date(NOW.getTime() - 30 * DAY_MS + i * MINUTE_MS);
      const recent = (i: number) =>
        new Date(NOW.getTime() - DAY_MS + i * MINUTE_MS);
      const statusOf = (i: number): TaskStatus => {
        if (i === 0) {
          return "succeeded";
        }
        if (i === 2 || i === 12) {
          return "failed";
        }
        return "cancelled";
      };

      // 65 ended Tasks: 10 a month old, 55 from the last day. The newest 50
      // are kept; of the 15 older ones, keep the only succeeded Task (0), the
      // one a later Task continues (1) and the recent failure (12).
      const seeded = [];
      for (let i = 0; i < 65; i++) {
        seeded.push(
          await seedScheduledTask({
            projectId,
            scheduleId,
            status: statusOf(i),
            scheduledFor: i < 10 ? old(i) : recent(i),
          }),
        );
      }
      const continued = seeded[1]?.task.id;
      if (!continued) {
        throw new Error("Expected the seeded Tasks");
      }
      const live = await seedScheduledTask({
        projectId,
        scheduleId,
        status: "queued",
        scheduledFor: recent(100),
        previousTaskId: continued,
      });
      const { workItemId } = await seedTaskPrerequisites(projectId);
      const unscheduled = await taskRepo.create(
        TaskEntity.create({
          projectId,
          workItemId,
          ...agentTaskInstructionColumns,
          status: "cancelled",
          createdAt: old(0),
        }),
      );

      const latestSucceededBefore =
        await taskRepo.findLatestSucceededScheduledFor(scheduleId);

      const { data, error } = await prune();

      expect(error).toBeNull();
      expect(data?.deleted).toBeGreaterThanOrEqual(12);

      const expectedDeleted = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14]);
      const deleted = seeded.filter((_, i) => expectedDeleted.has(i));
      const kept = seeded.filter((_, i) => !expectedDeleted.has(i));
      const remaining = await existingTaskIds([
        ...seeded.map((entry) => entry.task.id),
        live.task.id,
        unscheduled.id,
      ]);
      for (const entry of deleted) {
        expect(remaining.has(entry.task.id)).toBe(false);
      }
      for (const entry of kept) {
        expect(remaining.has(entry.task.id)).toBe(true);
      }
      expect(remaining.has(continued)).toBe(true);
      expect(remaining.has(live.task.id)).toBe(true);
      expect(remaining.has(unscheduled.id)).toBe(true);

      expect(
        await taskRepo.findLatestSucceededScheduledFor(scheduleId),
      ).toEqual(latestSucceededBefore);

      const deletedRunIds = deleted.map((entry) => entry.runId);
      const remainingRuns = await getDb()
        .select({ id: taskRuns.id })
        .from(taskRuns)
        .where(inArray(taskRuns.id, deletedRunIds));
      expect(remainingRuns).toHaveLength(0);
      const sweeps = await getDb()
        .select()
        .from(storageSweeps)
        .where(inArray(storageSweeps.taskRunId, deletedRunIds));
      expect(sweeps.map((sweep) => sweep.taskRunId).sort()).toEqual(
        [...deletedRunIds].sort(),
      );
      for (const sweep of sweeps) {
        expect(sweep.projectId).toBe(projectId);
      }

      const again = await prune();
      expect(again.error).toBeNull();
      expect(again.data).toEqual({ deleted: 0, batches: 0 });
      const afterSecond = await existingTaskIds(
        kept.map((entry) => entry.task.id),
      );
      expect(afterSecond.size).toBe(kept.length);
    },
  );
});
