import { describe, expect } from "bun:test";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { createAppContext } from "@/lib/di";
import { fireSchedule } from "@/pipeline-definitions/automation/application/fire-schedule";
import { TaskEntity } from "@/tasks/task/domain/task-entity";
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

const at = (minutes: number) =>
  new Date(Date.UTC(2026, 10, 2, 8, minutes, 0, 0));

const scheduleRule = (step: Step) => ({
  key: "poll",
  event: "schedule",
  cron: "*/15 * * * *",
  timezone: "UTC",
  concurrency: { max: 5, waiting: 0 },
  next: { routes: [{ kind: "step", to: step.key }] },
});

/** Publishes a project automation with one `poll` schedule rule. */
const publishSchedule = async (h: RunnerHarness, step: Step) => {
  const key = uniqueKey("poller");
  await h.publish(projectAutomation(key, [scheduleRule(step)]));
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
  return { key, automation, schedule };
};

const fire = async (
  target: Awaited<ReturnType<typeof publishSchedule>>,
  scheduledFor: Date,
  startedByUserId: UuidV7 | null = null,
): Promise<UuidV7> => {
  const result = await getDb().transaction(
    async (tx) =>
      await fireSchedule(
        {
          schedule: target.schedule,
          automation: {
            automation: target.automation,
            latestVersion: await appContext.automationRepo.loadLatestVersion(
              target.automation.id,
            ),
          },
          scheduledFor,
          startedByUserId,
        },
        appContext,
        tx,
      ),
  );
  if (result.outcome !== "fired" || result.taskId === null) {
    throw new Error(`Expected a started Task, got ${JSON.stringify(result)}`);
  }
  return result.taskId;
};

const setStatus = async (
  taskId: UuidV7,
  status: "succeeded" | "failed" | "cancelled",
) => {
  const task = await appContext.taskRepo.load(taskId);
  if (!task) {
    throw new Error(`No Task ${taskId}`);
  }
  await appContext.taskRepo.save(
    TaskEntity.rehydrate({ ...task.toJSON(), status }),
  );
};

const listAutomations = async (h: RunnerHarness) =>
  await unwrapAsync(
    h.apiClient.api
      .projects({ projectId: h.projectId })
      .automations.get({ headers: h.headers }),
  );

const summaryOf = async (h: RunnerHarness, key: string) => {
  const automation = (await listAutomations(h)).find(
    (entry) => entry.key === key,
  );
  if (!automation) {
    throw new Error(`No automation ${key} in the list`);
  }
  return automation.schedules;
};

const listRuns = async (
  h: RunnerHarness,
  query: { startedBy?: string; scheduleId?: string } = {},
) =>
  await unwrapAsync(
    h.apiClient.api
      .projects({ projectId: h.projectId })
      .runs.get({ query, headers: h.headers }),
  );

const taskDetail = async (h: RunnerHarness, taskId: UuidV7) =>
  await unwrapAsync(
    h.apiClient.api.tasks({ taskId }).get({ headers: h.headers }),
  );

/**
 * `GET /projects/:projectId/automations` lists each project automation's
 * schedules with how their runs went.
 */
describe("automation list: schedule summaries", () => {
  concurrentTest(
    "a schedule with no runs has no next run while the automation is disabled",
    async () => {
      const h = await createRunnerHarness("schedule-summary-empty");
      const poll = await h.createStep("poll");
      const { key, schedule } = await publishSchedule(h, poll);

      expect(await summaryOf(h, key)).toEqual([
        {
          id: schedule.id,
          key: "poll",
          cron: "*/15 * * * *",
          timezone: "UTC",
          concurrency: { max: 5, waiting: 0 },
          nextRunAt: null,
          lastFiredAt: null,
          lastTask: null,
          failureStreak: 0,
          lastSkippedAt: null,
          skippedCountSinceFire: 0,
          lastError: null,
        },
      ]);

      await h.enable(key);
      const [enabled] = await summaryOf(h, key);
      expect(enabled?.nextRunAt).not.toBeNull();
    },
  );

  concurrentTest(
    "the last Task, the failure streak since the last success, skips and the last error",
    async () => {
      const h = await createRunnerHarness("schedule-summary-runs");
      const poll = await h.createStep("poll");
      const target = await publishSchedule(h, poll);

      await setStatus(await fire(target, at(0)), "failed");
      await setStatus(await fire(target, at(15)), "succeeded");
      await setStatus(await fire(target, at(30)), "failed");
      await setStatus(await fire(target, at(45)), "cancelled");
      const last = await fire(target, at(50));
      await setStatus(last, "failed");
      await appContext.automationScheduleRepo.recordSkipped(
        target.schedule.id,
        NOW,
      );
      await appContext.automationScheduleRepo.recordError(target.schedule.id, {
        message: "Step archived",
        at: NOW,
        nextRunAt: at(75),
      });

      const [summary] = await summaryOf(h, target.key);
      expect(summary).toMatchObject({
        lastFiredAt: NOW.toISOString(),
        lastTask: {
          id: last,
          status: "failed",
          scheduledFor: at(50).toISOString(),
        },
        failureStreak: 2,
        lastSkippedAt: NOW.toISOString(),
        skippedCountSinceFire: 1,
        lastError: { message: "Step archived", at: NOW.toISOString() },
        nextRunAt: null,
      });
    },
  );

  concurrentTest("a removed rule's schedule is not listed", async () => {
    const h = await createRunnerHarness("schedule-summary-removed");
    const poll = await h.createStep("poll");
    const { key } = await publishSchedule(h, poll);

    await h.publish(projectAutomation(key, []));

    expect(await summaryOf(h, key)).toEqual([]);
  });
});

/**
 * Scheduled Tasks show their schedule as `startedBy`, in Task summaries and
 * on the Runs list, which can narrow to them.
 */
describe("scheduled Tasks: startedBy and the Runs list", () => {
  concurrentTest(
    "startedBy names the schedule, and the person for Run now",
    async () => {
      const h = await createRunnerHarness("schedule-started-by");
      const poll = await h.createStep("poll");
      const target = await publishSchedule(h, poll);
      const ticked = await fire(target, at(0));
      const ranNow = await fire(target, at(15), h.ownerId);
      const scheduleStarter = {
        kind: "schedule",
        automationId: target.automation.id,
        key: target.key,
        title: null,
        schedule: { id: target.schedule.id, key: "poll", removed: false },
      };

      expect(await taskDetail(h, ticked)).toMatchObject({
        startedBy: { ...scheduleStarter, user: null },
        scheduledFor: at(0).toISOString(),
      });
      expect(await taskDetail(h, ranNow)).toMatchObject({
        startedBy: { ...scheduleStarter, user: { userId: h.ownerId } },
        scheduledFor: at(15).toISOString(),
      });

      const page = await listRuns(h);
      const rows = new Map(page.runs.map((run) => [run.id, run]));
      expect(rows.get(ticked)).toMatchObject({
        title: `${target.key} · poll`,
        workItem: null,
        startedBy: { ...scheduleStarter, user: null },
      });
      expect(rows.get(ranNow)?.startedBy).toMatchObject({
        kind: "schedule",
        user: { userId: h.ownerId },
      });
    },
  );

  concurrentTest(
    "startedBy marks the schedule removed once its rule is gone",
    async () => {
      const h = await createRunnerHarness("schedule-started-by-removed");
      const poll = await h.createStep("poll");
      const target = await publishSchedule(h, poll);
      const taskId = await fire(target, at(0));

      await h.publish(projectAutomation(target.key, []));

      expect((await taskDetail(h, taskId)).startedBy).toMatchObject({
        kind: "schedule",
        schedule: { id: target.schedule.id, removed: true },
      });
      const history = await listRuns(h, { scheduleId: target.schedule.id });
      expect(history.runs.map((run) => run.id)).toEqual([taskId]);
      expect(history.runs[0]?.startedBy).toMatchObject({
        schedule: { removed: true },
      });
    },
  );

  concurrentTest(
    "startedBy=scheduled and scheduleId narrow the list, with a Scheduled facet",
    async () => {
      const h = await createRunnerHarness("schedule-runs-filter");
      const poll = await h.createStep("poll");
      const first = await publishSchedule(h, poll);
      const second = await publishSchedule(h, poll);
      const a = await fire(first, at(0));
      const b = await fire(second, at(0));
      const manual = await unwrapAsync(
        h.apiClient.api.tasks.post(
          {
            projectId: h.projectId,
            workItemId: await h.createItem(),
            stepDefinitionId: poll.id,
            stepDefinitionVersion: poll.version,
            inputJson: null,
          },
          { headers: h.headers },
        ),
      );

      const all = await listRuns(h);
      expect(all.runs.map((run) => run.id).sort()).toEqual(
        [a, b, manual.task.id].sort(),
      );
      expect(
        all.counts.startedBy.find((entry) => entry.filter === "scheduled"),
      ).toMatchObject({ label: "Scheduled", inProgress: 2 });

      const scheduled = await listRuns(h, { startedBy: "scheduled" });
      expect(scheduled.runs.map((run) => run.id).sort()).toEqual([a, b].sort());

      const one = await listRuns(h, { scheduleId: second.schedule.id });
      expect(one.runs.map((run) => run.id)).toEqual([b]);
    },
  );
});
