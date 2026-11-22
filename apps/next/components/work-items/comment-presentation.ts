/**
 * Presentation helpers for work item comments. The comment contract carries
 * `authorUserId` (the identity of record) plus an `authorUsername` resolved at
 * read time — never the email or a persisted name. Author display always shows
 * the author's username, falling back to a generic label only when no username
 * resolved (e.g. a deleted user).
 */

/** Format a timestamp as a GitHub-style relative time (e.g. "3 hours ago"). */
export function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return "";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "";

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return "just now";

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const divisions: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
    { amount: 60, unit: "second" },
    { amount: 60, unit: "minute" },
    { amount: 24, unit: "hour" },
    { amount: 7, unit: "day" },
    { amount: 4.34524, unit: "week" },
    { amount: 12, unit: "month" },
    { amount: Number.POSITIVE_INFINITY, unit: "year" },
  ];

  let duration = seconds;
  for (const division of divisions) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(-Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return "";
}

/** Absolute timestamp for tooltips. */
export function formatAbsoluteTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "";
}

/**
 * Display name for a comment author, shown by their `username` (resolved at read
 * time from `authorUserId`). Falls back to a generic label only when no username
 * is available.
 */
export function authorLabel(
  authorUsername: string | null | undefined,
): string {
  const trimmed = authorUsername?.trim();
  return trimmed ? trimmed : "Unknown user";
}
