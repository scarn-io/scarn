/**
 * Compiles a rule's `schedule` options (cron, timezone, concurrency),
 * checking them as publishing does.
 */
import {
  cronExpressionError,
  scheduleConcurrencySchema,
  timezoneError,
  type AutomationEvent,
} from "../contracts/automation-document";
import {
  issue,
  type CompileState,
  type Segment,
} from "../pipelines/compile-state";
import type { SourceSite } from "../pipelines/source";
import type { ScheduleOptions } from "./types";

/** The schedule options in `onEvent`'s options, if any were given. */
export function scheduleOptionsOf(
  options: object,
): ScheduleOptions | undefined {
  const { cron, timezone, concurrency } = options as Partial<ScheduleOptions>;
  if (
    cron === undefined &&
    timezone === undefined &&
    concurrency === undefined
  ) {
    return undefined;
  }
  return { cron: cron as string, timezone, concurrency };
}

/** The document fields for a rule's schedule options; reports bad ones. */
export function compileSchedule(
  state: CompileState,
  event: AutomationEvent,
  schedule: ScheduleOptions | undefined,
  site: SourceSite | null,
  base: readonly Segment[],
): Record<string, unknown> {
  const report = (field: string, message: string): void => {
    issue(state, site, [...base, field], message);
  };
  if (event !== "schedule") {
    if (schedule !== undefined) {
      report(
        "cron",
        `only a "schedule" rule takes cron, timezone and concurrency; "${event}" rules start when the event happens`,
      );
    }
    return {};
  }
  if (typeof schedule?.cron !== "string") {
    report("cron", 'a "schedule" rule needs a cron expression');
    return {};
  }
  const out: Record<string, unknown> = { cron: schedule.cron };
  const cronError = cronExpressionError(schedule.cron);
  if (cronError !== null) {
    report("cron", cronError);
  }
  if (schedule.timezone !== undefined) {
    const error =
      typeof schedule.timezone === "string"
        ? timezoneError(schedule.timezone)
        : "timezone must be an IANA timezone name";
    if (error !== null) {
      report("timezone", error);
    }
    out["timezone"] = schedule.timezone;
  }
  if (schedule.concurrency !== undefined) {
    const parsed = scheduleConcurrencySchema.safeParse(schedule.concurrency);
    if (!parsed.success) {
      report(
        "concurrency",
        "concurrency needs max, an integer of at least 1, and waiting, a non-negative integer",
      );
    }
    out["concurrency"] = schedule.concurrency;
  }
  return out;
}
