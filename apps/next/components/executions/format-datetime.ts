/**
 * Shared date/time formatting for the executions UI.
 *
 * `Intl.DateTimeFormat` instances are comparatively expensive to construct, so
 * they are created once at module scope and reused across renders rather than
 * calling `Date.prototype.toLocaleString()` on every render.
 */

const DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

const SHORT_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

const CLOCK_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const EM_DASH = "—";

/** Time of day, e.g. "1:24 PM". Returns `null` for falsy/invalid input. */
export function formatClockTime(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : CLOCK_TIME_FORMAT.format(date);
}

/** Full date + time, e.g. "Jun 24, 2026, 1:24:02 PM". Falsy input -> em dash. */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? EM_DASH : DATE_TIME_FORMAT.format(date);
}

/** Short date, e.g. "Jun 24". Returns `null` for falsy/invalid input. */
export function formatShortDate(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : SHORT_DATE_FORMAT.format(date);
}

const RELATIVE_FORMAT = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

const RELATIVE_STEPS: {
  limitMs: number;
  divisorMs: number;
  unit: Intl.RelativeTimeFormatUnit;
}[] = [
  { limitMs: 60_000, divisorMs: 1000, unit: "second" },
  { limitMs: 3_600_000, divisorMs: 60_000, unit: "minute" },
  { limitMs: 86_400_000, divisorMs: 3_600_000, unit: "hour" },
  { limitMs: 7 * 86_400_000, divisorMs: 86_400_000, unit: "day" },
];

/**
 * Compact relative time for list rows, e.g. "3 minutes ago". Beyond a week it
 * falls back to the full date ("on Jun 24, 2026"). Falsy input -> em dash.
 */
export function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return EM_DASH;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return EM_DASH;

  const deltaMs = date.getTime() - Date.now();
  const magnitude = Math.abs(deltaMs);
  for (const step of RELATIVE_STEPS) {
    if (magnitude < step.limitMs) {
      return RELATIVE_FORMAT.format(
        Math.round(deltaMs / step.divisorMs),
        step.unit,
      );
    }
  }
  return `on ${DATE_TIME_FORMAT.format(date)}`;
}
