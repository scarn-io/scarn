import { beforeEach, describe, expect } from "bun:test";
import { and, eq, isNull, lt } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  automations,
  automationSchedules,
  stepDefinitions,
  tasks,
} from "@/lib/db/schema";
import { createAppContext } from "@/lib/di";
import {
  tickAutomationSchedules,
  type TickAutomationSchedulesOptions,
} from "@/pipeline-definitions/automation/application/tick-automation-schedules";
import type { AutomationScheduleEntity } from "@/pipeline-definitions/automation/domain/automation-schedule-entity";
import { fixedTimeProvider, serialTest } from "tests/utils";
import {
  createRunnerHarness,
  projectAutomation,
  uniqueKey,
  type RunnerHarness,
  type Step,
} from "./automation-runner-test-support";

/**
 * The tick claims every due schedule in the database, so these tests run in
 * 2001, before any schedule another test file publishes is due, run one at a
 * time, and remove every 2001 schedule before each test.
 */
const ERA_END = new Date("2002-01-01T00:00:00.000Z");
const at = (iso: string) => new Date(`2001-06-15T${iso}Z`);

const tick = async (now: Date, options?: TickAutomationSchedulesOptions) =>
  await tickAutomationSchedules(
    createAppContext({ timeProvider: fixedTimeProvider(now) }),
    options,
  );

type ScheduleRule = {
  cron?: string;
  timezone?: string;
  concurrency?: { max: number; waiting: number };
};

/** Publishes an enabled project automation with one schedule rule starting `step`, due at `nextRunAt`. */
const publishDue = async (
  h: RunnerHarness,
  step: Step,
  nextRunAt: Date,
  rule: ScheduleRule = {},
): Promise<AutomationScheduleEntity> => {
  const key = uniqueKey("ticker");
  await h.publish(
    projectAutomation(key, [
      {
        key: "poll",
        event: "schedule",
        cron: rule.cron ?? "*/15 * * * *",
        timezone: rule.timezone ?? "UTC",
        ...(rule.concurrency ? { concurrency: rule.concurrency } : {}),
        next: { routes: [{ kind: "step", to: step.key }] },
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
  await getDb()
    .update(automations)
    .set({ enabled: true })
    .where(eq(automations.id, automation.id));
  const [schedule] =
    await appContext.automationScheduleRepo.listLiveByAutomationId(
      automation.id,
    );
  if (!schedule) {
    throw new Error("Expected the publish to create the schedule");
  }
  await getDb()
    .update(automationSchedules)
    .set({ nextRunAt })
    .where(eq(automationSchedules.id, schedule.id));
  return reload(schedule);
};

const appContext = createAppContext();

const reload = async (schedule: AutomationScheduleEntity) => {
  const loaded = await appContext.automationScheduleRepo.load(schedule.id);
  if (!loaded) {
    throw new Error("Expected the schedule");
  }
  return loaded;
};

const scheduledTasksOf = async (schedule: AutomationScheduleEntity) =>
  await getDb()
    .select({
      id: tasks.id,
      scheduledFor: tasks.scheduledFor,
      stepDefinitionId: tasks.stepDefinitionId,
    })
    .from(tasks)
    .where(eq(tasks.startedByScheduleId, schedule.id));

/**
 * `tickAutomationSchedules` is the cron tick: it fires each due schedule of
 * an enabled automation once, for its latest due cron time, and moves
 * `nextRunAt` to the next cron time after now whatever the outcome.
 */
describe("tickAutomationSchedules", () => {
  beforeEach(async () => {
    await getDb()
      .update(automationSchedules)
      .set({ removedAt: ERA_END })
      .where(
        and(
          lt(automationSchedules.nextRunAt, ERA_END),
          isNull(automationSchedules.removedAt),
        ),
      );
  });

  serialTest(
    "fires a due schedule once and advances nextRunAt; a not-due one waits",
    async () => {
      const h = await createRunnerHarness("tick-due");
      const poll = await h.createStep("poll");
      const due = await publishDue(h, poll, at("12:00:00"));
      const later = await publishDue(h, poll, at("12:15:00"));

      expect(await tick(at("12:00:20"))).toEqual({
        fired: 1,
        skipped: 0,
        collapsed: 0,
        errored: 0,
        deferred: 0,
      });

      expect(await scheduledTasksOf(due)).toMatchObject([
        { scheduledFor: at("12:00:00"), stepDefinitionId: poll.id },
      ]);
      expect(await reload(due)).toMatchObject({
        nextRunAt: at("12:15:00"),
        lastFiredAt: at("12:00:20"),
      });
      expect(await scheduledTasksOf(later)).toEqual([]);
      expect((await reload(later)).nextRunAt).toEqual(at("12:15:00"));

      expect(await tick(at("12:00:40"))).toMatchObject({ fired: 0 });
      expect(await scheduledTasksOf(due)).toHaveLength(1);
    },
  );

  serialTest(
    "missed cron times collapse into one run for the latest due time",
    async () => {
      const h = await createRunnerHarness("tick-collapse");
      const poll = await h.createStep("poll");
      const schedule = await publishDue(h, poll, at("12:00:00"));
      const onTime = await publishDue(h, poll, at("12:45:00"));

      expect(await tick(at("12:50:00"))).toEqual({
        fired: 2,
        skipped: 0,
        collapsed: 1,
        errored: 0,
        deferred: 0,
      });
      expect(await scheduledTasksOf(schedule)).toMatchObject([
        { scheduledFor: at("12:45:00") },
      ]);
      expect(await scheduledTasksOf(onTime)).toMatchObject([
        { scheduledFor: at("12:45:00") },
      ]);
      expect((await reload(schedule)).nextRunAt).toEqual(at("13:00:00"));
    },
  );

  serialTest(
    "a disabled automation or a removed schedule doesn't fire",
    async () => {
      const h = await createRunnerHarness("tick-disabled");
      const poll = await h.createStep("poll");
      const disabled = await publishDue(h, poll, at("12:00:00"));
      await getDb()
        .update(automations)
        .set({ enabled: false })
        .where(eq(automations.id, disabled.automationId));
      const removed = await publishDue(h, poll, at("12:00:00"));
      await getDb()
        .update(automationSchedules)
        .set({ removedAt: at("11:00:00") })
        .where(eq(automationSchedules.id, removed.id));

      expect(await tick(at("12:05:00"))).toMatchObject({
        fired: 0,
        deferred: 0,
      });
      expect(await scheduledTasksOf(disabled)).toEqual([]);
      expect(await scheduledTasksOf(removed)).toEqual([]);
      expect((await reload(disabled)).nextRunAt).toEqual(at("12:00:00"));
    },
  );

  serialTest(
    "a full concurrency group records a skip and still advances nextRunAt",
    async () => {
      const h = await createRunnerHarness("tick-skip");
      const poll = await h.createStep("poll");
      const schedule = await publishDue(h, poll, at("12:00:00"));

      expect(await tick(at("12:00:10"))).toMatchObject({ fired: 1 });
      expect(await tick(at("12:15:10"))).toEqual({
        fired: 0,
        skipped: 1,
        collapsed: 0,
        errored: 0,
        deferred: 0,
      });
      expect(await reload(schedule)).toMatchObject({
        nextRunAt: at("12:30:00"),
        lastFiredAt: at("12:00:10"),
        lastSkippedAt: at("12:15:10"),
        skippedCountSinceFire: 1,
      });
      expect(await scheduledTasksOf(schedule)).toHaveLength(1);
    },
  );

  serialTest(
    "a failed start records the error, advances nextRunAt and the tick carries on",
    async () => {
      const h = await createRunnerHarness("tick-error");
      const gone = await h.createStep("gone");
      const poll = await h.createStep("poll");
      const broken = await publishDue(h, gone, at("12:00:00"));
      const healthy = await publishDue(h, poll, at("12:00:00"));
      await getDb()
        .update(stepDefinitions)
        .set({ status: "archived" })
        .where(eq(stepDefinitions.id, gone.id));

      expect(await tick(at("12:01:00"))).toEqual({
        fired: 1,
        skipped: 0,
        collapsed: 0,
        errored: 1,
        deferred: 0,
      });
      expect(await reload(broken)).toMatchObject({
        nextRunAt: at("12:15:00"),
        lastErrorAt: at("12:01:00"),
        lastFiredAt: null,
      });
      expect((await reload(broken)).lastError).toContain(gone.key);
      expect(await scheduledTasksOf(broken)).toEqual([]);
      expect(await scheduledTasksOf(healthy)).toHaveLength(1);

      expect(await tick(at("12:02:00"))).toMatchObject({ errored: 0 });
    },
  );

  serialTest("the batch limit defers the rest to the next tick", async () => {
    const h = await createRunnerHarness("tick-limit");
    const poll = await h.createStep("poll");
    const schedules = [
      await publishDue(h, poll, at("12:00:00")),
      await publishDue(h, poll, at("12:00:00")),
      await publishDue(h, poll, at("12:00:00")),
    ];

    expect(await tick(at("12:00:30"), { batchLimit: 2 })).toMatchObject({
      fired: 2,
      deferred: 1,
    });
    expect(await tick(at("12:00:40"), { batchLimit: 2 })).toMatchObject({
      fired: 1,
      deferred: 0,
    });
    for (const schedule of schedules) {
      expect(await scheduledTasksOf(schedule)).toMatchObject([
        { scheduledFor: at("12:00:00") },
      ]);
    }
  });

  serialTest("overlapping ticks fire each schedule once", async () => {
    const h = await createRunnerHarness("tick-overlap");
    const poll = await h.createStep("poll");
    const schedules = await Promise.all(
      Array.from(
        { length: 6 },
        async () => await publishDue(h, poll, at("12:00:00")),
      ),
    );

    const results = await Promise.all([
      tick(at("12:00:30")),
      tick(at("12:00:30")),
      tick(at("12:00:30")),
    ]);

    expect(results.reduce((sum, each) => sum + each.fired, 0)).toBe(6);
    expect(results.every((each) => each.errored === 0)).toBe(true);
    for (const schedule of schedules) {
      expect(await scheduledTasksOf(schedule)).toHaveLength(1);
    }
  });

  serialTest("a cron reads its timezone", async () => {
    const h = await createRunnerHarness("tick-timezone");
    const poll = await h.createStep("poll");
    const nineInNewYork = at("13:00:00");
    const schedule = await publishDue(h, poll, nineInNewYork, {
      cron: "0 9 * * *",
      timezone: "America/New_York",
    });

    expect(await tick(at("12:59:00"))).toMatchObject({ fired: 0 });
    expect(await tick(at("13:00:30"))).toMatchObject({ fired: 1 });
    expect(await scheduledTasksOf(schedule)).toMatchObject([
      { scheduledFor: nineInNewYork },
    ]);
    expect((await reload(schedule)).nextRunAt).toEqual(
      new Date("2001-06-16T13:00:00.000Z"),
    );
  });
});
