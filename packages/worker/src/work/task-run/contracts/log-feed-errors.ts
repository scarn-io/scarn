/**
 * Limits a task run's live log feed enforces on appends, raised by both the
 * log feed socket (a nack's `code`) and the worker API client (`POST
 * /api/task-runs/:id/logs`).
 *
 * {@link LogFeedFullError}: the run's feed hit its size cap; further appends
 * are refused for the rest of the run. {@link LogFeedRateLimitedError}: the
 * feed is throttling appends; the same batch can be retried later.
 */
export class LogFeedFullError extends Error {
  override readonly name = "LogFeedFullError";
}

export class LogFeedRateLimitedError extends Error {
  override readonly name = "LogFeedRateLimitedError";
}

const LOG_FEED_LIMIT_HTTP_CODES: Record<string, number> = {
  TASK_LOG_FEED_FULL: 413,
  TASK_LOG_FEED_RATE_LIMITED: 429,
};

/** The error an API `{ code }` response maps to, when it is a log feed limit. */
export function logFeedLimitErrorFromHttp(
  status: number,
  code: string | undefined,
): LogFeedFullError | LogFeedRateLimitedError | null {
  if (code === undefined || LOG_FEED_LIMIT_HTTP_CODES[code] !== status) {
    return null;
  }
  return code === "TASK_LOG_FEED_FULL"
    ? new LogFeedFullError(`Task log feed is full (HTTP ${String(status)})`)
    : new LogFeedRateLimitedError(
        `Task log feed is rate limited (HTTP ${String(status)})`,
      );
}

/** The error a log feed socket nack `code` maps to, when it is a limit. */
export function logFeedLimitErrorFromNack(
  code: string,
): LogFeedFullError | LogFeedRateLimitedError | null {
  if (code === "feed-full") {
    return new LogFeedFullError("Log feed rejected batch: feed-full");
  }
  if (code === "rate-limited") {
    return new LogFeedRateLimitedError("Log feed rejected batch: rate-limited");
  }
  return null;
}
