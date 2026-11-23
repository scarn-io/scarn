import { describe, expect } from "bun:test";
import type { UuidV7 } from "@/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { createAppContext } from "@/lib/di";
import { fireSchedule } from "@/pipeline-definitions/automation/application/fire-schedule";
import { TaskEntity } from "@/tasks/task/domain/task-entity";
import { createProjectSecretsTestUser } from "tests/secrets/secret/integration/project-secret-test-support";
import { concurrentTest, fixedTimeProvider, unwrapAsync } from "tests/utils";
import {
  createRunnerHarness,
  projectAutomation,
  uniqueKey,
  workItemAutomation,
  type RunnerHarness,
  type Step,
} from "./automation-runner-test-support";

const NOW = new Date("2026-11-02T09:00:00.000Z");
const appContext = createAppContext({ timeProvider: fixedTimeProvider(NOW) });

const windowInput = {
  type: "object",
  properties: {
    since: { type: ["string", "null"] },
    until: { type: "string" },
  },
  additionalProperties: false,
};

const scheduleRule = (
  step: Step,
  extra: { concurrency?: { max: number; waiting: number }; args?: object } = {},
) => ({
  key: "poll",
  event: "schedule",
  cron: "*/15 * * * *",
  timezone: "UTC",
  ...(extra.concurrency ? { concurrency: extra.concurrency } : {}),
  next: {
    routes: [
      {
        kind: "step",
        to: step.key,
        ...(extra.args ? { args: extra.args } : {}),
      },
    ],
  },
});

const publishSchedule = async (
  h: RunnerHarness,
  step: Step,
  extra?: Parameters<typeof scheduleRule>[1],
) => {
  const key = uniqueKey("poller");
  await h.publish(projectAutomation(key, [scheduleRule(step, extra)]));
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

const runNow = async (
  h: RunnerHarness,
  key: string,
  ruleKey = "poll",
  headers: Record<string, string> = h.headers,
) =>
  await h.apiClient.api
    .projects({ projectId: h.projectId })
    .automations({ key })
    .schedules({ ruleKey })
    .runs.post(undefined, { headers });

const startedTaskId = (result: Awaited<ReturnType<typeof runNow>>): UuidV7 => {
  const taskId = result.data?.taskId;
  if (!taskId) {
    throw new Error(`Expected a started Task, got ${JSON.stringify(result)}`);
  }
  return taskId;
};

const taskOf = async (taskId: UuidV7) => {
  const task = await appContext.taskRepo.load(taskId);
  if (!task) {
    throw new Error(`No Task ${taskId}`);
  }
  return task;
};

const reloadSchedule = async (id: UuidV7) => {
  const schedule = await appContext.automationScheduleRepo.load(id);
  if (!schedule) {
    throw new Error(`No schedule ${id}`);
  }
  return schedule;
};

/**
 * Run now (`POST /projects/:projectId/automations/:key/schedules/:ruleKey/runs`)
 * fires a schedule once for now, through the tick's path, recording who asked.
 */
describe("Run now", () => {
  concurrentTest(
    "starts a Task for now, owned by the schedule and the person, while the automation is disabled",
    async () => {
      const h = await createRunnerHarness("run-now-start");
      const poll = await h.createStep("poll");
      const { key, automation, schedule } = await publishSchedule(h, poll);
      expect(automation.enabled).toBe(false);

      const result = await runNow(h, key);

      expect(result.response.status).toBe(201);
      expect(result.data?.scheduledFor).toBe(NOW.toISOString());
      expect(await taskOf(startedTaskId(result))).toMatchObject({
        projectId: h.projectId,
        workItemId: null,
        startedByAutomationId: automation.id,
        startedByScheduleId: schedule.id,
        startedByUserId: h.ownerId,
        scheduledFor: NOW,
        status: "queued",
      });
      expect(await reloadSchedule(schedule.id)).toMatchObject({
        lastFiredAt: NOW,
      });
    },
  );

  concurrentTest("leaves the schedule's next run where it was", async () => {
    const h = await createRunnerHarness("run-now-next-run");
    const poll = await h.createStep("poll");
    const { key, schedule } = await publishSchedule(h, poll);
    await h.enable(key);
    const before = (await reloadSchedule(schedule.id)).nextRunAt;

    expect((await runNow(h, key)).response.status).toBe(201);

    expect((await reloadSchedule(schedule.id)).nextRunAt).toEqual(before);
  });

  concurrentTest(
    "a full concurrency group is a 409 naming the open Task, not a recorded skip",
    async () => {
      const h = await createRunnerHarness("run-now-full");
      const poll = await h.createStep("poll");
      const { key, schedule } = await publishSchedule(h, poll);
      const holder = startedTaskId(await runNow(h, key));

      const second = await runNow(h, key);

      expect(second.error?.status).toBe(409);
      expect(second.error?.value).toMatchObject({
        code: "Scarn.ConcurrencyGroupFull",
        meta: { scheduleId: schedule.id, heldBy: [holder] },
      });
      expect(await reloadSchedule(schedule.id)).toMatchObject({
        lastSkippedAt: null,
        skippedCountSinceFire: 0,
      });
    },
  );

  concurrentTest(
    "a second Run now for the same instant is a 409 conflict",
    async () => {
      const h = await createRunnerHarness("run-now-same-instant");
      const poll = await h.createStep("poll");
      const { key } = await publishSchedule(h, poll, {
        concurrency: { max: 5, waiting: 0 },
      });
      expect((await runNow(h, key)).response.status).toBe(201);

      const second = await runNow(h, key);

      expect(second.error?.status).toBe(409);
      expect(second.error?.value).toMatchObject({
        code: "AUTOMATION_SCHEDULE_RUN_CONFLICT",
      });
    },
  );

  concurrentTest(
    "404s an unknown automation, an unknown rule key and a removed schedule",
    async () => {
      const h = await createRunnerHarness("run-now-missing");
      const poll = await h.createStep("poll");
      const { key } = await publishSchedule(h, poll);

      expect((await runNow(h, uniqueKey("nope"))).error?.status).toBe(404);
      expect((await runNow(h, key, "nope")).error?.status).toBe(404);

      await h.publish(projectAutomation(key, []));
      expect((await runNow(h, key)).error?.status).toBe(404);
    },
  );

  concurrentTest("400s a work-item automation", async () => {
    const h = await createRunnerHarness("run-now-work-item");
    const key = uniqueKey("wi");
    await h.publish(workItemAutomation(key, []));

    const result = await runNow(h, key);

    expect(result.error?.status).toBe(400);
    expect(result.error?.value).toMatchObject({
      code: "AUTOMATION_NOT_PROJECT_SCOPE",
    });
  });

  concurrentTest("requires executions:write", async () => {
    const h = await createRunnerHarness("run-now-permission");
    const poll = await h.createStep("poll");
    const { key, schedule } = await publishSchedule(h, poll);
    const reader = await createProjectSecretsTestUser("run-now-reader");
    const { inviteUrl } = await unwrapAsync(
      h.apiClient.api
        .projects({ projectId: h.projectId })
        .invites.post(
          { email: reader.email, role: "read", restriction: "specific_email" },
          { headers: h.headers },
        ),
    );
    await unwrapAsync(
      h.apiClient.api["project-invites"]({
        token: inviteUrl.split("/invite/")[1] ?? "",
      }).accept.post(undefined, { headers: reader.authHeaders }),
    );

    const result = await runNow(h, key, "poll", reader.authHeaders);

    expect(result.error?.status).toBe(403);
    expect(await reloadSchedule(schedule.id)).toMatchObject({
      lastFiredAt: null,
    });
  });

  concurrentTest(
    "a succeeded Run now moves previousScheduledFor forward",
    async () => {
      const h = await createRunnerHarness("run-now-previous");
      const poll = await h.createStep("poll", { inputSchemaJson: windowInput });
      const { key, automation, schedule } = await publishSchedule(h, poll, {
        args: {
          since: "event.schedule.previousScheduledFor",
          until: "event.schedule.scheduledFor",
        },
      });
      const ran = await taskOf(startedTaskId(await runNow(h, key)));
      expect(ran.inputJson).toEqual({
        since: null,
        until: NOW.toISOString(),
      });
      await appContext.taskRepo.save(
        TaskEntity.rehydrate({ ...ran.toJSON(), status: "succeeded" }),
      );
      await getDb().transaction(async (tx) => {
        await appContext.taskGroup.ended(await taskOf(ran.id), tx);
      });

      const later = new Date("2026-11-02T09:15:00.000Z");
      const next = await getDb().transaction(
        async (tx) =>
          await fireSchedule(
            {
              schedule: await reloadSchedule(schedule.id),
              automation: {
                automation,
                latestVersion:
                  await appContext.automationRepo.loadLatestVersion(
                    automation.id,
                  ),
              },
              scheduledFor: later,
            },
            appContext,
            tx,
          ),
      );
      if (next.outcome !== "fired" || next.taskId === null) {
        throw new Error(`Expected a started Task, got ${JSON.stringify(next)}`);
      }
      expect((await taskOf(next.taskId)).inputJson).toEqual({
        since: NOW.toISOString(),
        until: later.toISOString(),
      });
    },
  );
});
