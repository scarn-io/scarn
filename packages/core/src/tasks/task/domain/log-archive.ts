/**
 * When a run's log is archived to object storage. `always` keeps every run's
 * log. `on-failure` (code steps only) skips the log of a succeeded run that
 * no person started, such as a scheduled sync: it isn't kept and doesn't
 * count toward log storage. Failed, cancelled and timed-out runs, and runs a
 * person started (Run now), are always kept.
 */
export const logArchiveValues = ["always", "on-failure"] as const;

export type LogArchive = (typeof logArchiveValues)[number];

export const DEFAULT_LOG_ARCHIVE: LogArchive = "always";

export const isLogArchive = (value: unknown): value is LogArchive =>
  typeof value === "string" &&
  (logArchiveValues as readonly string[]).includes(value);

/** Whether a run that ended with `runStatus` keeps its log. */
export const shouldArchiveRunLog = ({
  logArchive,
  runStatus,
  startedByUserId,
}: {
  logArchive: LogArchive;
  runStatus: string;
  startedByUserId: string | null;
}): boolean =>
  logArchive === "always" ||
  runStatus !== "succeeded" ||
  startedByUserId !== null;
