import { Elysia } from "elysia";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAppContext, type AppContext } from "@scarn/core/lib/di";
import type { AutomationScheduleRepo } from "@scarn/core/pipeline-definitions/automation/application/automation-schedule-repo";
import type { WorkSignal } from "@scarn/core/tasks/task-run/application/work-signal";
import { apiErrorHandler } from "../error-handler";
import { createAutomationSchedulesTickRoutes } from "./automation-schedules-tick";

const SECRET = "test-automation-schedule-tick-token-0123456789";
const OTHER_SECRET = "test-integration-poll-token-0123456789abcdef";

// A fake repo with nothing due, so the route runs the real tick. Every other
// method throws if called.
const notImplemented = (): never => {
  throw new Error("not implemented in this fake");
};

const fakeAutomationScheduleRepo: AutomationScheduleRepo = {
  load: notImplemented,
  findLive: notImplemented,
  listLiveByAutomationId: notImplemented,
  listSummariesByAutomationIds: notImplemented,
  countLiveEnabledInProject: notImplemented,
  insert: notImplemented,
  update: notImplemented,
  claimNextDue: () => Promise.resolve(null),
  countDue: () => Promise.resolve(0),
  advanceNextRunAt: notImplemented,
  recordFired: notImplemented,
  recordSkipped: notImplemented,
  recordError: notImplemented,
};

const fakeWorkSignal: WorkSignal = {
  notify: () => Promise.resolve(),
};

const buildApp = (appContext: AppContext) =>
  new Elysia()
    .onError((context) => apiErrorHandler(context))
    .use(createAutomationSchedulesTickRoutes(appContext));

const post = (app: ReturnType<typeof buildApp>, headers?: HeadersInit) =>
  app.handle(
    new Request("http://localhost/internal/automations/schedules/tick", {
      method: "POST",
      headers,
    }),
  );

describe("POST /internal/automations/schedules/tick", () => {
  const appContext = createAppContext({
    automationScheduleRepo: fakeAutomationScheduleRepo,
    workSignal: fakeWorkSignal,
  });

  let original: string | undefined;
  let originalOther: string | undefined;

  beforeEach(() => {
    original = process.env["AUTOMATION_SCHEDULE_TICK_CRON_SECRET"];
    process.env["AUTOMATION_SCHEDULE_TICK_CRON_SECRET"] = SECRET;
    originalOther = process.env["INTEGRATION_POLL_CRON_SECRET"];
    process.env["INTEGRATION_POLL_CRON_SECRET"] = OTHER_SECRET;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env["AUTOMATION_SCHEDULE_TICK_CRON_SECRET"];
    } else {
      process.env["AUTOMATION_SCHEDULE_TICK_CRON_SECRET"] = original;
    }
    if (originalOther === undefined) {
      delete process.env["INTEGRATION_POLL_CRON_SECRET"];
    } else {
      process.env["INTEGRATION_POLL_CRON_SECRET"] = originalOther;
    }
  });

  test("returns 401 without a bearer token", async () => {
    const res = await post(buildApp(appContext));
    expect(res.status).toBe(401);
  });

  test("returns 401 with a wrong bearer token", async () => {
    const res = await post(buildApp(appContext), {
      authorization: "Bearer wrong-token",
    });
    expect(res.status).toBe(401);
  });

  test("returns 401 with a token that only matches another cron secret", async () => {
    const res = await post(buildApp(appContext), {
      authorization: `Bearer ${OTHER_SECRET}`,
    });
    expect(res.status).toBe(401);
  });

  test("returns 200 with the tick's counts given a valid AUTOMATION_SCHEDULE_TICK_CRON_SECRET token", async () => {
    const res = await post(buildApp(appContext), {
      authorization: `Bearer ${SECRET}`,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      fired: 0,
      skipped: 0,
      collapsed: 0,
      errored: 0,
      deferred: 0,
    });
  });
});
