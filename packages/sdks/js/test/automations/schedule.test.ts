/**
 * `schedule` rules: `onEvent("schedule")` compiles cron, timezone,
 * concurrency and `r.schedule` refs, and both `defineAutomation` and
 * `automationDocumentSchema` reject what a schedule rule can't have.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { codeStep } from "@scarn/sdk/definitions/steps";
import { PipelineBuildError } from "@scarn/sdk/pipelines";
import {
  attach,
  defineAutomation,
  onEvent,
  skip,
  type AutomationDefinition,
} from "@scarn/sdk/automations";
import {
  automationDocumentSchema,
  cronExpressionError,
  latestCronTimeAtOrBefore,
  nextCronTime,
  schedulesOf,
  timezoneError,
} from "@scarn/sdk/contracts/automation-document";
import { plan, triage, wayfinder } from "./fixtures/wayfinder";

const poll = codeStep({
  key: "poll-acme-api",
  name: "Poll Acme",
  inputSchema: z.object({
    since: z.string().nullable(),
    until: z.string(),
  }),
  fn: () => ({}),
});

function buildError(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof PipelineBuildError) {
      return error.issues.map((issue) => `${issue.pointer}: ${issue.message}`);
    }
    throw error;
  }
  throw new Error("expected a build error");
}

function untyped(config: object): AutomationDefinition {
  return defineAutomation(config as Parameters<typeof defineAutomation>[0]);
}

describe("cron and timezone checks", () => {
  test.each([
    "*/15 * * * *",
    "0 9 * * MON-FRI",
    "0 0 1 JAN *",
    "@daily",
    "@Hourly",
  ])("accepts %p", (cron) => {
    expect(cronExpressionError(cron)).toBeNull();
  });

  test.each([
    ["0 */15 * * * *", "no seconds field"],
    ["0 0 ? * *", "day of month"],
    ["0 0 L * *", "day of month"],
    ["0 0 15W * *", "day of month"],
    ["0 0 * * 1#2", "day of week"],
    ["61 * * * *", "minute"],
    ["@reboot", "isn't a cron alias"],
    ["* * *", "has 3 fields"],
  ])("rejects %p", (cron, message) => {
    expect(cronExpressionError(cron)).toContain(message);
  });

  test("timezones are IANA names", () => {
    expect(timezoneError("UTC")).toBeNull();
    expect(timezoneError("America/Argentina/Buenos_Aires")).toBeNull();
    expect(timezoneError("Mars/Olympus_Mons")).toContain("IANA");
    expect(timezoneError("")).toContain("IANA");
  });

  test("nextCronTime is strictly after and reads the timezone", () => {
    const at = new Date("2026-01-01T00:15:00.000Z");
    expect(nextCronTime("*/15 * * * *", "UTC", at)?.toISOString()).toBe(
      "2026-01-01T00:30:00.000Z",
    );
    expect(nextCronTime("@daily", "Europe/Stockholm", at)?.toISOString()).toBe(
      "2026-01-01T23:00:00.000Z",
    );
  });

  test("latestCronTimeAtOrBefore includes the instant itself and reads the timezone", () => {
    const at = new Date("2026-01-01T00:15:00.000Z");
    expect(
      latestCronTimeAtOrBefore("*/15 * * * *", "UTC", at)?.toISOString(),
    ).toBe("2026-01-01T00:15:00.000Z");
    expect(
      latestCronTimeAtOrBefore(
        "*/15 * * * *",
        "UTC",
        new Date("2026-01-01T00:14:59.999Z"),
      )?.toISOString(),
    ).toBe("2026-01-01T00:00:00.000Z");
    expect(
      latestCronTimeAtOrBefore(
        "0 9 * * *",
        "America/New_York",
        at,
      )?.toISOString(),
    ).toBe("2025-12-31T14:00:00.000Z");
  });
});

describe("onEvent schedule", () => {
  test("compiles a schedule rule with r.schedule refs", () => {
    const automation = defineAutomation({
      key: "acme",
      scope: "project",
      rules: [
        onEvent({
          key: "poll-acme",
          event: "schedule",
          cron: "*/15 * * * *",
          timezone: "Europe/Stockholm",
          concurrency: { max: 1, waiting: 1 },
          to: (r) =>
            poll({
              since: r.schedule.previousScheduledFor,
              until: r.schedule.scheduledFor,
            }),
        }),
        onEvent({
          key: "nightly",
          event: "schedule",
          cron: "@daily",
          to: plan,
        }),
      ],
    });
    expect(automation.document.rules).toEqual([
      {
        key: "poll-acme",
        event: "schedule",
        cron: "*/15 * * * *",
        timezone: "Europe/Stockholm",
        concurrency: { max: 1, waiting: 1 },
        next: {
          routes: [
            {
              kind: "step",
              to: "poll-acme-api",
              args: {
                since: "event.schedule.previousScheduledFor",
                until: "event.schedule.scheduledFor",
              },
            },
          ],
        },
      },
      {
        key: "nightly",
        event: "schedule",
        cron: "@daily",
        next: { routes: [{ kind: "step", to: "plan" }] },
      },
    ]);
    expect(
      automationDocumentSchema.safeParse(automation.document).success,
    ).toBe(true);
    expect(schedulesOf(automation.document)).toEqual([
      {
        key: "poll-acme",
        cron: "*/15 * * * *",
        timezone: "Europe/Stockholm",
        concurrency: { max: 1, waiting: 1 },
      },
      {
        key: "nightly",
        cron: "@daily",
        timezone: "UTC",
        concurrency: { max: 1, waiting: 0 },
      },
    ]);
  });

  test("other events still compile on: workItem", () => {
    expect(wayfinder.document.rules[0]?.next.routes[0]).toEqual({
      kind: "step",
      to: "plan",
      on: "workItem",
    });
  });

  test("a bad cron, timezone or concurrency is a build error", () => {
    expect(
      buildError(() =>
        defineAutomation({
          key: "x",
          scope: "project",
          rules: [
            onEvent({
              key: "s",
              event: "schedule",
              cron: "0 */15 * * * *",
              timezone: "Nowhere/Land",
              concurrency: { max: 0, waiting: 0 },
              to: skip,
            }),
          ],
        }),
      ),
    ).toEqual([
      '/rules/0/cron: "0 */15 * * * *" has 6 fields; a cron expression has 5 (minute hour day-of-month month day-of-week) and no seconds field',
      '/rules/0/timezone: "Nowhere/Land" isn\'t an IANA timezone name like "UTC" or "Europe/Stockholm"',
      "/rules/0/concurrency: concurrency needs max, an integer of at least 1, and waiting, a non-negative integer",
    ]);
  });

  test("a schedule rule without cron is a build error", () => {
    expect(
      buildError(() =>
        untyped({
          key: "x",
          scope: "project",
          rules: [onEvent({ key: "s", event: "schedule", to: skip } as never)],
        }),
      ),
    ).toEqual(['/rules/0/cron: a "schedule" rule needs a cron expression']);
  });

  test("schedule in a work-item automation is a build error", () => {
    expect(
      buildError(() =>
        untyped({
          key: "x",
          scope: "workItem",
          rules: [
            onEvent({ key: "s", event: "schedule", cron: "@daily", to: skip }),
          ],
        }),
      ),
    ).toEqual([
      '/rules/0/event: "schedule" isn\'t an event of a work-item automation',
    ]);
  });

  test("pipelines, attach and .on(...) are build errors on a schedule rule", () => {
    const errors = buildError(() =>
      untyped({
        key: "x",
        scope: "project",
        rules: [
          onEvent({
            key: "s",
            event: "schedule",
            cron: "@daily",
            match: "all",
            routes: [
              { to: triage as never },
              { to: attach(wayfinder) as never },
              {
                to: ((r: { workItem: object }) =>
                  plan().on(r.workItem as never)) as never,
              },
            ],
          } as never),
        ],
      }),
    );
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain(
      "/rules/0/next/routes/0: a schedule rule can only start a step or skip",
    );
    expect(errors[1]).toContain(
      "/rules/0/next/routes/1: a schedule rule can only start a step or skip",
    );
    expect(errors[2]).toStartWith(
      "/rules/0/next/routes/2: .on(...) takes the work item",
    );
  });
});

describe("automationDocumentSchema schedule rules", () => {
  const project = (rules: object[]) => ({
    kind: "automation",
    schemaVersion: 1,
    key: "k",
    scope: "project",
    rules,
  });
  const schedule = (
    fields: object,
    target: object = { kind: "step", to: "s" },
  ) => ({
    key: "s",
    event: "schedule",
    cron: "*/15 * * * *",
    ...fields,
    next: { routes: [target] },
  });
  const issues = (input: object) =>
    automationDocumentSchema
      .safeParse(input)
      .error?.issues.map((issue) => issue.path.join("/")) ?? [];

  test("accepts a valid schedule rule", () => {
    expect(
      issues(
        project([
          schedule({ timezone: "UTC", concurrency: { max: 2, waiting: 0 } }),
          schedule({ key: "t", cron: "@hourly" }, { kind: "skip" }),
        ]),
      ),
    ).toEqual([]);
  });

  test.each([
    ["an invalid cron", { cron: "not a cron" }],
    ["a seconds field", { cron: "0 * * * * *" }],
    ["Quartz syntax", { cron: "0 0 ? * MON" }],
  ])("rejects %s", (_name, fields) => {
    expect(issues(project([schedule(fields)]))).toEqual(["rules/0/cron"]);
  });

  test("rejects a bad timezone and concurrency", () => {
    expect(
      issues(
        project([
          schedule({
            timezone: "Nowhere",
            concurrency: { max: 0, waiting: -1 },
          }),
        ]),
      ),
    ).toEqual([
      "rules/0/timezone",
      "rules/0/concurrency/max",
      "rules/0/concurrency/waiting",
    ]);
  });

  test("rejects a schedule rule without cron, and cron on other events", () => {
    expect(
      issues(
        project([
          { key: "s", event: "schedule", next: { routes: [{ kind: "skip" }] } },
        ]),
      ),
    ).toEqual(["rules/0/cron"]);
    expect(
      issues(
        project([
          {
            key: "w",
            event: "workItem.created",
            cron: "@daily",
            next: { routes: [{ kind: "skip" }] },
          },
        ]),
      ),
    ).toEqual(["rules/0"]);
  });

  test("rejects on, pipeline and attach targets on a schedule rule", () => {
    expect(
      issues(
        project([
          {
            ...schedule({}),
            next: {
              match: "all",
              routes: [
                { kind: "step", to: "s", on: "workItem" },
                { kind: "pipeline", to: "p", on: "workItem" },
              ],
              otherwise: { kind: "attach", automation: "a" },
            },
          },
        ]),
      ),
    ).toEqual([
      "rules/0/next/routes/0/on",
      "rules/0/next/routes/1/kind",
      "rules/0/next/otherwise/kind",
    ]);
  });

  test("rejects a step without on on other events", () => {
    expect(
      issues(
        project([
          {
            key: "w",
            event: "workItem.created",
            next: { routes: [{ kind: "step", to: "s" }] },
          },
        ]),
      ),
    ).toEqual(["rules/0/next/routes/0/on"]);
  });

  test("rejects schedule in a work-item automation", () => {
    expect(issues({ ...project([schedule({})]), scope: "workItem" })).toEqual([
      "rules/0/event",
    ]);
  });
});
