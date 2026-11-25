import { describe, expect } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import type { DbExecutor } from "@/lib/db/db-executor";
import { automations, tasks } from "@/lib/db/schema";
import { AutomationScheduleEntity } from "@/pipeline-definitions/automation/domain/automation-schedule-entity";
import { ConcurrencyGroupFullError } from "@/tasks/task/application/task-group";
import { TaskEntity, type TaskStatus } from "@/tasks/task/domain/task-entity";
import { expectPgError } from "tests/lib/db/orchestration-schema-test-support";
import { agentTaskInstructionColumns } from "tests/lib/db/seed-task-prerequisites";
import { concurrentTest } from "tests/utils";
import {
  createConcurrencyGroupHarness,
  type Step,
} from "./concurrency-group-test-support";

const NOW = new Date("2026-11-02T12:00:00.000Z");

/**
 * A Task a schedule started belongs to the schedule's concurrency group: the
 * schedule rule's `{ max, waiting }` limits every live Task it started, and
 * the step's own per-work-item group doesn't see it.
 */
describe("Schedule concurrency groups", () => {
  const { appContext, requireSetup, createStep, seedItem, startTask, stateOf } =
    createConcurrencyGroupHarness("schedule-concurrency");
  const { taskGroup, taskRepo, automationScheduleRepo } = appContext;

  const seedSchedule = async (concurrency: {
    max: number;
    waiting: number;
  }) => {
    const { projectId } = requireSetup();
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
        { key: "poll", cron: "*/15 * * * *", timezone: "UTC", concurrency },
        NOW,
      ),
    );
    return schedule.id;
  };

  let clock = 0;
  const seedScheduledTask = async (
    scheduleId: UuidV7,
    step: Step,
    status: TaskStatus,
  ) => {
    clock += 1;
    const createdAt = new Date(NOW.getTime() + clock * 1000);
    return await taskRepo.create(
      TaskEntity.create({
        projectId: requireSetup().projectId,
        workItemId: null,
        stepDefinitionId: step.id,
        kind: "agent",
        prompt: "Poll the API.",
        status,
        startedByScheduleId: scheduleId,
        scheduledFor: createdAt,
        createdAt,
      }),
    );
  };

  const inTx = async <T>(work: (tx: DbExecutor) => Promise<T>) =>
    await getDb().transaction(async (tx) => await work(tx));

  const arrive = async (
    scheduleId: UuidV7,
    concurrency: { max: number; waiting: number },
  ) =>
    await inTx(
      async (tx) =>
        await taskGroup.arrive(
          { projectId: requireSetup().projectId, scheduleId, concurrency },
          tx,
        ),
    );

  const end = async (task: TaskEntity) => {
    await inTx(async (tx) => {
      const ended = await taskRepo.save(
        TaskEntity.rehydrate({
          ...task.toJSON(),
          status: "succeeded",
          updatedAt: NOW,
        }),
        tx,
      );
      await taskGroup.ended(ended, tx);
    });
  };

  concurrentTest(
    "arrive admits up to max, then waits up to waiting, then drops",
    async () => {
      const concurrency = { max: 1, waiting: 1 };
      const scheduleId = await seedSchedule(concurrency);
      const step = await createStep(null);

      expect(await arrive(scheduleId, concurrency)).toEqual({
        decision: "admit",
      });
      const holder = await seedScheduledTask(scheduleId, step, "queued");
      expect(await arrive(scheduleId, concurrency)).toEqual({
        decision: "wait",
      });
      await seedScheduledTask(scheduleId, step, "waiting_for_concurrency_slot");
      expect(await arrive(scheduleId, concurrency)).toEqual({
        decision: "drop",
        heldBy: [holder.id],
      });
    },
  );

  concurrentTest(
    "the default { max: 1, waiting: 0 } drops while a run is open",
    async () => {
      const concurrency = { max: 1, waiting: 0 };
      const scheduleId = await seedSchedule(concurrency);
      const step = await createStep(null);
      const holder = await seedScheduledTask(scheduleId, step, "running");

      expect(await arrive(scheduleId, concurrency)).toEqual({
        decision: "drop",
        heldBy: [holder.id],
      });
    },
  );

  concurrentTest(
    "ended promotes the oldest waiting scheduled Task under the schedule's limit",
    async () => {
      const scheduleId = await seedSchedule({ max: 1, waiting: 2 });
      const step = await createStep({ max: 5, waiting: 5 });
      const holder = await seedScheduledTask(scheduleId, step, "queued");
      const oldest = await seedScheduledTask(
        scheduleId,
        step,
        "waiting_for_concurrency_slot",
      );
      const newer = await seedScheduledTask(
        scheduleId,
        step,
        "waiting_for_concurrency_slot",
      );

      await end(holder);

      expect(await stateOf(oldest.id)).toEqual({
        status: "queued",
        runs: [{ number: 1, reason: "initial", status: "queued" }],
      });
      expect(await stateOf(newer.id)).toEqual({
        status: "waiting_for_concurrency_slot",
        runs: [],
      });
    },
  );

  concurrentTest(
    "a removed schedule's waiting Tasks are still promoted",
    async () => {
      const scheduleId = await seedSchedule({ max: 1, waiting: 1 });
      const schedule = await automationScheduleRepo.load(scheduleId);
      if (!schedule) {
        throw new Error("Expected the schedule");
      }
      await automationScheduleRepo.update(schedule.remove(NOW));
      const step = await createStep(null);
      const holder = await seedScheduledTask(scheduleId, step, "queued");
      const waiting = await seedScheduledTask(
        scheduleId,
        step,
        "waiting_for_concurrency_slot",
      );

      await end(holder);

      expect((await stateOf(waiting.id)).status).toBe("queued");
    },
  );

  concurrentTest("different schedules' groups are independent", async () => {
    const concurrency = { max: 1, waiting: 0 };
    const busy = await seedSchedule(concurrency);
    const idle = await seedSchedule(concurrency);
    await seedScheduledTask(busy, await createStep(null), "running");

    expect(await arrive(idle, concurrency)).toEqual({ decision: "admit" });
  });

  concurrentTest(
    "a scheduled Task and a work item's Tasks of the same step don't share a group",
    async () => {
      const step = await createStep({ max: 1, waiting: 0 });
      const scheduleId = await seedSchedule({ max: 1, waiting: 0 });
      const scheduled = await seedScheduledTask(scheduleId, step, "queued");
      const workItemId = await seedItem();

      const onItem = await startTask(workItemId, step);

      expect(onItem.task.status).toBe("queued");
      expect(await arrive(scheduleId, { max: 1, waiting: 0 })).toEqual({
        decision: "drop",
        heldBy: [scheduled.id],
      });
    },
  );

  concurrentTest(
    "reacquire for a scheduled Task checks the schedule's group",
    async () => {
      const scheduleId = await seedSchedule({ max: 1, waiting: 5 });
      const step = await createStep(null);
      const ended = await seedScheduledTask(scheduleId, step, "failed");
      const holder = await seedScheduledTask(scheduleId, step, "running");

      const failure = await inTx(async (tx) => {
        try {
          await taskGroup.reacquire(ended, tx);
          return null;
        } catch (error) {
          return error;
        }
      });

      expect(failure).toBeInstanceOf(ConcurrencyGroupFullError);
      expect(failure).toMatchObject({
        heldBy: [holder.id],
        meta: { scheduleId, heldBy: [holder.id] },
      });
    },
  );

  concurrentTest(
    "the database rejects a Task with no work item, conversation or schedule",
    async () => {
      await expectPgError(
        () =>
          getDb()
            .insert(tasks)
            .values({
              id: createUuidV7(),
              projectId: requireSetup().projectId,
              workItemId: null,
              conversationId: null,
              startedByScheduleId: null,
              ...agentTaskInstructionColumns,
              status: "queued",
              schemaVersion: 1,
            }),
        { code: "23514", constraint: "tasks_owner_check" },
      );
    },
  );
});
