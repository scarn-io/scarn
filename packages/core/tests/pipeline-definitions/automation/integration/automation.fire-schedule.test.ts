import { describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { automationSchedules, tasks, workItemActivity } from "@/lib/db/schema";
import { createAppContext } from "@/lib/di";
import {
  fireSchedule,
  type FireScheduleInput,
  type FireScheduleResult,
} from "@/pipeline-definitions/automation/application/fire-schedule";
import type { AutomationScheduleEntity } from "@/pipeline-definitions/automation/domain/automation-schedule-entity";
import { TaskEntity } from "@/tasks/task/domain/task-entity";
import { expectPgError } from "tests/lib/db/orchestration-schema-test-support";
import { grant } from "tests/tasks/task/grants-test-support";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import {
  createRunnerHarness,
  projectAutomation,
  uniqueKey,
  type RunnerHarness,
  type Step,
} from "./automation-runner-test-support";

const NOW = new Date("2026-11-02T09:00:00.000Z");
const appContext = createAppContext({ timeProvider: fixedTimeProvider(NOW) });

const windowInput = {
  type: "object",
  properties: {
    key: { type: "string" },
    since: { type: ["string", "null"] },
    until: { type: "string" },
    timezone: { type: "string" },
  },
  additionalProperties: false,
};

const at = (minutes: number) =>
  new Date(Date.UTC(2026, 10, 2, 8, minutes, 0, 0));

type Rule = {
  concurrency?: { max: number; waiting: number };
  next: object;
};

/** Publishes a project automation with one `poll` schedule rule; returns what `fireSchedule` takes. */
const publishSchedule = async (h: RunnerHarness, rule: Rule) => {
  const key = uniqueKey("poller");
  await h.publish(
    projectAutomation(key, [
      {
        key: "poll",
        event: "schedule",
        cron: "*/15 * * * *",
        timezone: "Europe/London",
        ...rule,
      },
    ]),
  );
  const automation = await appContext.automationRepo.findByKey(
    h.projectId,
    key,
  );
  if (!automation) {
    throw new Error(`No automation ${key}`);
  }
  const [schedule] =
    await appContext.automationScheduleRepo.listLiveByAutomationId(
      automation.id,
    );
  if (!schedule) {
    throw new Error("Expected the publish to create the schedule");
  }
  const latestVersion = await appContext.automationRepo.loadLatestVersion(
    automation.id,
  );
  return { schedule, automation: { automation, latestVersion } };
};

const fire = async (
  target: Omit<FireScheduleInput, "scheduledFor">,
  scheduledFor: Date,
  startedByUserId: UuidV7 | null = null,
) =>
  await getDb().transaction(
    async (tx) =>
      await fireSchedule(
        { ...target, scheduledFor, startedByUserId },
        appContext,
        tx,
      ),
  );

const reload = async (schedule: AutomationScheduleEntity) => {
  const loaded = await appContext.automationScheduleRepo.load(schedule.id);
  if (!loaded) {
    throw new Error("Expected the schedule");
  }
  return loaded;
};

/** The Task a fire started; throws when it started none. */
const firedTaskId = (result: FireScheduleResult): UuidV7 => {
  if (result.outcome !== "fired" || result.taskId === null) {
    throw new Error(`Expected a started Task, got ${JSON.stringify(result)}`);
  }
  return result.taskId;
};

const taskOf = async (taskId: UuidV7) => {
  const task = await appContext.taskRepo.load(taskId);
  if (!task) {
    throw new Error(`No Task ${taskId}`);
  }
  return task;
};

const setStatus = async (taskId: UuidV7, status: "succeeded" | "failed") => {
  const task = await taskOf(taskId);
  await appContext.taskRepo.save(
    TaskEntity.rehydrate({ ...task.toJSON(), status }),
  );
};

const stepTo = (step: Step, args?: Record<string, string>) => ({
  routes: [{ kind: "step", to: step.key, ...(args ? { args } : {}) }],
});

const scheduledTasksOf = async (schedule: AutomationScheduleEntity) =>
  await getDb()
    .select({ id: tasks.id, scheduledFor: tasks.scheduledFor })
    .from(tasks)
    .where(eq(tasks.startedByScheduleId, schedule.id));

/**
 * `fireSchedule` runs one schedule rule: it starts the picked step as a Task
 * the schedule owns, with no work item, through the schedule's concurrency
 * group, and records the fire or skip on the schedule.
 */
describe("fireSchedule", () => {
  concurrentTest(
    "starts a Task with no work item, owned by the schedule, keeping only project grants",
    async () => {
      const h = await createRunnerHarness("fire-schedule-start");
      const poll = await h.createStep("poll", {
        grants: [grant("read", "project"), grant("create", "project", ["x"])],
      });
      const target = await publishSchedule(h, { next: stepTo(poll) });

      const result = await fire(target, at(45));

      const taskId = firedTaskId(result);
      const task = await taskOf(taskId);
      expect(task).toMatchObject({
        projectId: h.projectId,
        workItemId: null,
        conversationId: null,
        stepDefinitionId: poll.id,
        startedByAutomationId: target.automation.automation.id,
        startedByScheduleId: target.schedule.id,
        scheduledFor: at(45),
        startedByUserId: null,
        status: "queued",
      });
      expect(task.grants).toEqual([
        grant("read", "project"),
        grant("create", "project", ["x"]),
      ]);
      expect(await appContext.taskRunRepo.listByTaskId(task.id)).toMatchObject([
        { number: 1, reason: "initial", status: "queued" },
      ]);
      expect(await reload(target.schedule)).toMatchObject({
        lastFiredAt: NOW,
        skippedCountSinceFire: 0,
        lastSkippedAt: null,
      });
    },
  );

  concurrentTest(
    "args read event.schedule; previousScheduledFor follows the latest succeeded Task",
    async () => {
      const h = await createRunnerHarness("fire-schedule-args");
      const poll = await h.createStep("poll", { inputSchemaJson: windowInput });
      const target = await publishSchedule(h, {
        concurrency: { max: 5, waiting: 0 },
        next: stepTo(poll, {
          key: "event.schedule.key",
          since: "event.schedule.previousScheduledFor",
          until: "event.schedule.scheduledFor",
          timezone: "event.schedule.timezone",
        }),
      });
      const inputOf = async (scheduledFor: Date) => {
        const result = await fire(target, scheduledFor);
        const taskId = firedTaskId(result);
        return { taskId, inputJson: (await taskOf(taskId)).inputJson };
      };

      const first = await inputOf(at(0));
      expect(first.inputJson).toEqual({
        key: "poll",
        since: null,
        until: at(0).toISOString(),
        timezone: "Europe/London",
      });
      await setStatus(first.taskId, "succeeded");

      const second = await inputOf(at(15));
      expect(second.inputJson).toMatchObject({
        since: at(0).toISOString(),
        until: at(15).toISOString(),
      });
      await setStatus(second.taskId, "failed");

      expect((await inputOf(at(30))).inputJson).toMatchObject({
        since: at(0).toISOString(),
        until: at(30).toISOString(),
      });
    },
  );

  concurrentTest(
    "when routes on event.schedule refs, and a skip route fires without a Task",
    async () => {
      const h = await createRunnerHarness("fire-schedule-when");
      const backfill = await h.createStep("backfill");
      const poll = await h.createStep("poll");
      const routed = await publishSchedule(h, {
        concurrency: { max: 5, waiting: 0 },
        next: {
          routes: [
            {
              when: {
                path: "event.schedule.previousScheduledFor",
                op: "equal",
                value: null,
              },
              kind: "step",
              to: backfill.key,
            },
          ],
          otherwise: { kind: "step", to: poll.key },
        },
      });

      const first = await fire(routed, at(0));
      const firstTask = await taskOf(firedTaskId(first));
      expect(firstTask.stepDefinitionId).toBe(backfill.id);
      await setStatus(firstTask.id, "succeeded");
      const second = await fire(routed, at(15));
      expect((await taskOf(firedTaskId(second))).stepDefinitionId).toBe(
        poll.id,
      );

      const skipping = await publishSchedule(h, {
        next: { routes: [{ kind: "skip" }] },
      });
      expect(await fire(skipping, at(0))).toEqual({
        outcome: "fired",
        taskId: null,
      });
      expect(await scheduledTasksOf(skipping.schedule)).toEqual([]);
      expect(await reload(skipping.schedule)).toMatchObject({
        lastFiredAt: NOW,
      });
    },
  );

  concurrentTest(
    "the default concurrency skips while a run is open and records the skip",
    async () => {
      const h = await createRunnerHarness("fire-schedule-skip");
      const poll = await h.createStep("poll");
      const target = await publishSchedule(h, { next: stepTo(poll) });

      const first = await fire(target, at(0));
      const holder = firedTaskId(first);
      expect(await fire(target, at(15))).toEqual({
        outcome: "skipped",
        heldBy: [holder],
      });
      expect(await fire(target, at(30))).toMatchObject({
        outcome: "skipped",
      });
      expect(await reload(target.schedule)).toMatchObject({
        lastFiredAt: NOW,
        lastSkippedAt: NOW,
        skippedCountSinceFire: 2,
      });
      expect(await scheduledTasksOf(target.schedule)).toHaveLength(1);

      await setStatus(holder, "succeeded");
      await getDb().transaction(async (tx) => {
        await appContext.taskGroup.ended(await taskOf(holder), tx);
      });
      expect(await fire(target, at(45))).toMatchObject({ outcome: "fired" });
      expect(await reload(target.schedule)).toMatchObject({
        skippedCountSinceFire: 0,
      });
    },
  );

  concurrentTest(
    "{ max: 1, waiting: 1 } queues the second run waiting for a slot",
    async () => {
      const h = await createRunnerHarness("fire-schedule-wait");
      const poll = await h.createStep("poll", {
        concurrency: { max: 5, waiting: 5 },
      });
      const target = await publishSchedule(h, {
        concurrency: { max: 1, waiting: 1 },
        next: stepTo(poll),
      });

      await fire(target, at(0));
      const waiting = await fire(target, at(15));
      const task = await taskOf(firedTaskId(waiting));
      expect(task.status).toBe("waiting_for_concurrency_slot");
      expect(await appContext.taskRunRepo.listByTaskId(task.id)).toEqual([]);
      expect(await fire(target, at(30))).toMatchObject({
        outcome: "skipped",
      });
    },
  );

  concurrentTest(
    "a second run for the same scheduledFor violates the unique index",
    async () => {
      const h = await createRunnerHarness("fire-schedule-unique");
      const poll = await h.createStep("poll");
      const target = await publishSchedule(h, {
        concurrency: { max: 5, waiting: 0 },
        next: stepTo(poll),
      });

      await fire(target, at(0));
      await expectPgError(async () => await fire(target, at(0)), {
        code: "23505",
        constraint: "tasks_started_by_schedule_id_scheduled_for_unique",
      });
      expect(await scheduledTasksOf(target.schedule)).toHaveLength(1);
    },
  );

  concurrentTest(
    "a Run now records who asked, and nothing writes activity lines",
    async () => {
      const h = await createRunnerHarness("fire-schedule-activity");
      const poll = await h.createStep("poll");
      const target = await publishSchedule(h, { next: stepTo(poll) });
      const result = await fire(target, NOW, h.ownerId);

      expect(result).toMatchObject({ outcome: "fired" });
      expect((await taskOf(firedTaskId(result))).startedByUserId).toBe(
        h.ownerId,
      );
      expect(
        await getDb()
          .select()
          .from(workItemActivity)
          .where(eq(workItemActivity.projectId, h.projectId)),
      ).toEqual([]);
      expect(
        (
          await getDb()
            .select({ lastFiredAt: automationSchedules.lastFiredAt })
            .from(automationSchedules)
            .where(eq(automationSchedules.id, target.schedule.id))
        )[0]?.lastFiredAt,
      ).toEqual(NOW);
    },
  );

  concurrentTest(
    "a scheduled run is claimed without a work-item filter, runs and succeeds",
    async () => {
      const h = await createRunnerHarness("fire-schedule-claim");
      const poll = await h.createStep("poll");
      const target = await publishSchedule(h, { next: stepTo(poll) });
      const result = await fire(target, at(0));
      const taskId = firedTaskId(result);
      const claim = async (workItemId?: UuidV7) =>
        await unwrapAsync(
          h.apiClient.api["task-runs"].claims.post(
            {
              projectId: h.projectId,
              workerId: `scheduled-${crypto.randomUUID()}`,
              batchSize: 10,
              leaseDurationSeconds: 30,
              ...(workItemId ? { workItemId } : {}),
            },
            { headers: h.headers },
          ),
        );

      expect(await claim(await h.createItem())).toEqual([]);
      const [claimed, ...rest] = await claim();
      expect(rest).toEqual([]);
      expect(claimed?.task).toMatchObject({ taskId, workItemId: null });
      if (!claimed) {
        throw new Error("Expected to claim the scheduled run");
      }
      const routes = h.apiClient.api["task-runs"]({
        taskRunId: claimed.task.id,
      });
      const context = await unwrapAsync(
        routes["worker-context"].post(
          { claimToken: claimed.claimToken },
          { headers: h.headers },
        ),
      );
      expect(context.task.key).toBe(poll.key);
      expect(context.task.prompt).toContain("Do the work.");
      expect(context.task.prompt).not.toContain("Work item id");
      await unwrapAsync(
        routes.completions.post(
          {
            claimToken: claimed.claimToken,
            status: "succeeded",
            resultJson: {},
            errorJson: null,
          },
          { headers: h.headers },
        ),
      );

      expect((await taskOf(taskId)).status).toBe("succeeded");
      expect(await fire(target, at(15))).toMatchObject({ outcome: "fired" });
    },
  );
});
