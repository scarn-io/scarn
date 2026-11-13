import type { UuidV7 } from "../../../common/contracts/uuid-v7";

/** Short-lived access to the project's push wake-up socket (`apps/work-signal`). */
export type WorkSignalToken = {
  url: string;
  token: string;
  expiresAt: string;
};

/**
 * A claim's write access to its run's live log feed: a per-run
 * `wss://…/task-runs/<id>/ws` URL and a short-lived write token. A claim
 * carries `null` when the server has no log feed, which keeps logs on HTTP.
 */
export type LogFeedToken = {
  url: string;
  token: string;
  expiresAt: string;
};

/**
 * Issues a fresh write token for a claimed run's log feed socket. Resolves
 * `null` when the feed is unavailable to this claim (404, or 409 once the
 * claim is lost or the run left "running"). Absent on worker clients with no
 * API behind them, which leaves the socket on its first token.
 */
export type IssueLogFeedWriteToken = (input: {
  taskRunId: UuidV7;
  claimToken: string;
}) => Promise<LogFeedToken | null>;
