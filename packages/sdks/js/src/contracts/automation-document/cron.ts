/**
 * Cron expressions and timezones of `schedule` rules: standard 5-field cron
 * (minute, hour, day of month, month, day of week) or one of the `@` aliases
 * in {@link CRON_ALIASES}, read in an IANA timezone. There is no seconds
 * field and no Quartz syntax (`?`, `L`, `W`, `#`). Parsed with `croner`,
 * which runs on Bun, Node, Workers and in browsers.
 *
 * The same checks run in `defineAutomation`, in the document schema and at
 * publish, and the server computes `next_run_at` with {@link nextCronTime}.
 */
import { Cron } from "croner";

export const CRON_ALIASES = [
  "@yearly",
  "@annually",
  "@monthly",
  "@weekly",
  "@daily",
  "@midnight",
  "@hourly",
] as const;

export const DEFAULT_SCHEDULE_TIMEZONE = "UTC";

const MONTH_NAMES = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/gi;
const DAY_NAMES = /\b(sun|mon|tue|wed|thu|fri|sat)\b/gi;
const NUMERIC_FIELD = /^[0-9*,/-]+$/;
const FIELD_NAMES = [
  "minute",
  "hour",
  "day of month",
  "month",
  "day of week",
] as const;
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

function fieldSyntaxError(index: number, field: string): string | null {
  const names = index === 3 ? MONTH_NAMES : index === 4 ? DAY_NAMES : undefined;
  const numeric = names === undefined ? field : field.replace(names, "0");
  if (NUMERIC_FIELD.test(numeric)) {
    return null;
  }
  const nameHint =
    index === 3
      ? " and month names (JAN)"
      : index === 4
        ? " and day names (MON)"
        : "";
  return `the ${FIELD_NAMES[index] ?? "field"} field "${field}" may only use digits, "*", ",", "-", "/"${nameHint}`;
}

/**
 * Why `cron` isn't a valid schedule expression, or null when it is: 5 fields
 * or an `@` alias, with no seconds field and no Quartz syntax.
 */
export function cronExpressionError(cron: string): string | null {
  const trimmed = cron.trim();
  if (trimmed.startsWith("@")) {
    return (CRON_ALIASES as readonly string[]).includes(trimmed.toLowerCase())
      ? null
      : `"${cron}" isn't a cron alias; use one of ${CRON_ALIASES.join(", ")}`;
  }
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) {
    return `"${cron}" has ${String(fields.length)} fields; a cron expression has 5 (minute hour day-of-month month day-of-week)${fields.length > 5 ? " and no seconds field" : ""}`;
  }
  for (const [index, field] of fields.entries()) {
    const error = fieldSyntaxError(index, field);
    if (error !== null) {
      return `"${cron}": ${error}`;
    }
  }
  let parsed: Cron;
  try {
    parsed = new Cron(trimmed, { mode: "5-part" });
  } catch (error) {
    return `"${cron}" isn't a valid cron expression: ${error instanceof Error ? error.message.replace(/^CronPattern: /, "") : String(error)}`;
  }
  if (parsed.nextRun() === null) {
    return `"${cron}" never matches a date`;
  }
  return null;
}

/** Why `timezone` isn't an IANA timezone name, or null when it is. */
export function timezoneError(timezone: string): string | null {
  const invalid = `"${timezone}" isn't an IANA timezone name like "UTC" or "Europe/Stockholm"`;
  if (!IANA_NAME.test(timezone)) {
    return invalid;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    return invalid;
  }
  return null;
}

/**
 * The first time `cron` matches in `timezone` strictly after `after`, or null
 * when it never matches again. Daylight saving follows croner: a time in a
 * skipped hour fires at the next valid time, one in a repeated hour fires once.
 */
export function nextCronTime(
  cron: string,
  timezone: string,
  after: Date,
): Date | null {
  return new Cron(cron.trim(), { mode: "5-part", timezone }).nextRun(after);
}

/**
 * The latest time `cron` matches in `timezone` at or before `at`, or null when
 * it never matched before. Cron times fall on whole minutes.
 */
export function latestCronTimeAtOrBefore(
  cron: string,
  timezone: string,
  at: Date,
): Date | null {
  const [latest] = new Cron(cron.trim(), {
    mode: "5-part",
    timezone,
  }).previousRuns(1, new Date(at.getTime() + 1));
  return latest ?? null;
}
