import { beforeAll, describe, expect } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { automationSchedules, automations } from "@/lib/db/schema";
import { concurrentTest, unwrapAsync } from "tests/utils";
import {
  createAutomationFixture,
  projectAutomationDocument,
  publishAutomationRequest,
  type AutomationFixture,
} from "./automation-test-support";

type ScheduleRuleInput = {
  key: string;
  cron: string;
  timezone?: string;
  concurrency?: { max: number; waiting: number };
};

const SENTINEL = new Date("2030-01-01T00:00:00.000Z");

const scheduleRule = (
  fixture: AutomationFixture,
  { key, ...settings }: ScheduleRuleInput,
) => ({
  key,
  event: "schedule",
  ...settings,
  next: { routes: [{ kind: "step", to: fixture.planStepKey }] },
});

const hourlyRules = (fixture: AutomationFixture, count: number) =>
  Array.from({ length: count }, (_, index) =>
    scheduleRule(fixture, {
      key: `hourly-${String(index)}`,
      cron: "0 * * * *",
    }),
  );

const publish = (
  fixture: AutomationFixture,
  key: string,
  rules: readonly object[],
) =>
  publishAutomationRequest(
    fixture,
    projectAutomationDocument(key, rules),
    fixture.headers,
  );

const toggle = (
  fixture: AutomationFixture,
  key: string,
  action: "enable" | "disable",
) =>
  fixture.apiClient.api
    .projects({ projectId: fixture.projectId })
    .automations({ key })
    [action].post(undefined, { headers: { ...fixture.headers } });

const automationIdOf = async (fixture: AutomationFixture, key: string) => {
  const [row] = await getDb()
    .select({ id: automations.id })
    .from(automations)
    .where(
      and(
        eq(automations.projectId, fixture.projectId),
        eq(automations.key, key),
      ),
    );
  if (!row) {
    throw new Error(`No automation '${key}'`);
  }
  return row.id;
};

const schedulesOf = async (fixture: AutomationFixture, key: string) =>
  await getDb()
    .select()
    .from(automationSchedules)
    .where(
      eq(automationSchedules.automationId, await automationIdOf(fixture, key)),
    )
    .orderBy(asc(automationSchedules.createdAt), asc(automationSchedules.id));

const liveSchedule = async (
  fixture: AutomationFixture,
  key: string,
  ruleKey: string,
) => {
  const rows = await schedulesOf(fixture, key);
  const live = rows.find(
    (row) => row.key === ruleKey && row.removedAt === null,
  );
  if (!live) {
    throw new Error(`No live schedule '${ruleKey}' on '${key}'`);
  }
  return live;
};

const setNextRunAt = async (id: string, nextRunAt: Date) => {
  await getDb()
    .update(automationSchedules)
    .set({ nextRunAt })
    .where(eq(automationSchedules.id, id));
};

describe("syncing automation schedules", () => {
  let fixture: AutomationFixture;

  beforeAll(async () => {
    fixture = await createAutomationFixture("schedules");
  });

  concurrentTest(
    "publishing inserts a schedule per schedule rule",
    async () => {
      const key = `nightly-${crypto.randomUUID()}`;
      await unwrapAsync(
        publish(fixture, key, [
          scheduleRule(fixture, { key: "hourly", cron: "0 * * * *" }),
          scheduleRule(fixture, {
            key: "nightly",
            cron: "@daily",
            timezone: "America/New_York",
            concurrency: { max: 2, waiting: 1 },
          }),
          {
            key: "work-item-created",
            event: "workItem.created",
            next: { routes: [{ kind: "skip" }] },
          },
        ]),
      );
      const rows = await schedulesOf(fixture, key);
      expect(
        rows.map(
          ({ key: ruleKey, cron, timezone, concurrencyJson, nextRunAt }) => ({
            ruleKey,
            cron,
            timezone,
            concurrencyJson,
            nextRunAt: nextRunAt.toISOString(),
          }),
        ),
      ).toEqual([
        {
          ruleKey: "hourly",
          cron: "0 * * * *",
          timezone: "UTC",
          concurrencyJson: { max: 1, waiting: 0 },
          nextRunAt: "2026-11-01T10:00:00.000Z",
        },
        {
          ruleKey: "nightly",
          cron: "@daily",
          timezone: "America/New_York",
          concurrencyJson: { max: 2, waiting: 1 },
          nextRunAt: "2026-11-02T05:00:00.000Z",
        },
      ]);
      expect(rows.every((row) => row.removedAt === null)).toBe(true);
    },
  );

  concurrentTest(
    "the same cron keeps its next run and takes the new concurrency",
    async () => {
      const key = `keep-${crypto.randomUUID()}`;
      await unwrapAsync(
        publish(fixture, key, [
          scheduleRule(fixture, { key: "hourly", cron: "0 * * * *" }),
        ]),
      );
      const before = await liveSchedule(fixture, key, "hourly");
      await setNextRunAt(before.id, SENTINEL);

      await unwrapAsync(
        publish(fixture, key, [
          scheduleRule(fixture, {
            key: "hourly",
            cron: "0 * * * *",
            concurrency: { max: 3, waiting: 2 },
          }),
        ]),
      );
      const after = await liveSchedule(fixture, key, "hourly");
      expect(after.id).toBe(before.id);
      expect(after.nextRunAt.toISOString()).toBe(SENTINEL.toISOString());
      expect(after.concurrencyJson).toEqual({ max: 3, waiting: 2 });
    },
  );

  concurrentTest(
    "a changed cron or timezone recomputes the next run",
    async () => {
      const key = `retime-${crypto.randomUUID()}`;
      await unwrapAsync(
        publish(fixture, key, [
          scheduleRule(fixture, { key: "noon", cron: "0 12 * * *" }),
        ]),
      );
      const created = await liveSchedule(fixture, key, "noon");
      expect(created.nextRunAt.toISOString()).toBe("2026-11-01T12:00:00.000Z");

      await setNextRunAt(created.id, SENTINEL);
      await unwrapAsync(
        publish(fixture, key, [
          scheduleRule(fixture, { key: "noon", cron: "30 12 * * *" }),
        ]),
      );
      const recronned = await liveSchedule(fixture, key, "noon");
      expect(recronned.id).toBe(created.id);
      expect(recronned.nextRunAt.toISOString()).toBe(
        "2026-11-01T12:30:00.000Z",
      );

      await setNextRunAt(created.id, SENTINEL);
      await unwrapAsync(
        publish(fixture, key, [
          scheduleRule(fixture, {
            key: "noon",
            cron: "30 12 * * *",
            timezone: "America/New_York",
          }),
        ]),
      );
      const rezoned = await liveSchedule(fixture, key, "noon");
      expect(rezoned.id).toBe(created.id);
      expect(rezoned.timezone).toBe("America/New_York");
      expect(rezoned.nextRunAt.toISOString()).toBe("2026-11-01T17:30:00.000Z");
    },
  );

  concurrentTest(
    "a removed key is marked removed and returns as a new schedule",
    async () => {
      const key = `remove-${crypto.randomUUID()}`;
      const hourly = scheduleRule(fixture, {
        key: "hourly",
        cron: "0 * * * *",
      });
      const skip = {
        key: "work-item-created",
        event: "workItem.created",
        next: { routes: [{ kind: "skip" }] },
      };
      await unwrapAsync(publish(fixture, key, [hourly]));
      const original = await liveSchedule(fixture, key, "hourly");

      await unwrapAsync(publish(fixture, key, [skip]));
      const removed = await schedulesOf(fixture, key);
      expect(removed).toHaveLength(1);
      expect(removed[0]?.removedAt?.toISOString()).toBe(
        "2026-11-01T09:00:00.000Z",
      );

      await unwrapAsync(publish(fixture, key, [hourly, skip]));
      const rows = await schedulesOf(fixture, key);
      expect(rows).toHaveLength(2);
      const revived = await liveSchedule(fixture, key, "hourly");
      expect(revived.id).not.toBe(original.id);
      expect(revived.nextRunAt.toISOString()).toBe("2026-11-01T10:00:00.000Z");
    },
  );

  concurrentTest("enabling recomputes the next run", async () => {
    const key = `enable-${crypto.randomUUID()}`;
    await unwrapAsync(
      publish(fixture, key, [
        scheduleRule(fixture, { key: "hourly", cron: "0 * * * *" }),
      ]),
    );
    const schedule = await liveSchedule(fixture, key, "hourly");
    await setNextRunAt(schedule.id, SENTINEL);

    await unwrapAsync(toggle(fixture, key, "enable"));
    const enabled = await liveSchedule(fixture, key, "hourly");
    expect(enabled.nextRunAt.toISOString()).toBe("2026-11-01T10:00:00.000Z");

    await setNextRunAt(schedule.id, SENTINEL);
    await unwrapAsync(toggle(fixture, key, "disable"));
    const disabled = await liveSchedule(fixture, key, "hourly");
    expect(disabled.nextRunAt.toISOString()).toBe(SENTINEL.toISOString());
    expect(disabled.removedAt).toBeNull();
  });
});

describe("the per-project schedule limit", () => {
  let fixture: AutomationFixture;
  let fullKey: string;

  beforeAll(async () => {
    fixture = await createAutomationFixture("schedule-limit");
    fullKey = `full-${crypto.randomUUID()}`;
    await unwrapAsync(publish(fixture, fullKey, hourlyRules(fixture, 20)));
    await unwrapAsync(toggle(fixture, fullKey, "enable"));
  });

  concurrentTest("enable rejects going over the limit", async () => {
    const key = `extra-${crypto.randomUUID()}`;
    await unwrapAsync(publish(fixture, key, hourlyRules(fixture, 1)));
    const response = await toggle(fixture, key, "enable");
    expect(response.error?.status).toBe(422);
    expect(response.error?.value).toMatchObject({
      code: "AUTOMATION_SCHEDULE_LIMIT_EXCEEDED",
    });
  });

  concurrentTest(
    "publishing an enabled automation rejects going over the limit",
    async () => {
      const response = await publish(
        fixture,
        fullKey,
        hourlyRules(fixture, 21),
      );
      expect(response.error?.status).toBe(422);
      expect(response.error?.value).toMatchObject({
        code: "AUTOMATION_SCHEDULE_LIMIT_EXCEEDED",
      });
      expect(
        (await schedulesOf(fixture, fullKey)).filter(
          (row) => row.removedAt === null,
        ),
      ).toHaveLength(20);
    },
  );

  concurrentTest("automations without schedules still enable", async () => {
    const key = `plain-${crypto.randomUUID()}`;
    await unwrapAsync(
      publish(fixture, key, [
        {
          key: "work-item-created",
          event: "workItem.created",
          next: { routes: [{ kind: "skip" }] },
        },
      ]),
    );
    const enabled = await unwrapAsync(toggle(fixture, key, "enable"));
    expect(enabled.enabled).toBe(true);
  });
});
