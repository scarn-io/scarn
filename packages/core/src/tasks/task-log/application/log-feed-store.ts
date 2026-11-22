import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreError } from "@scarn/core/lib/errors";
import type {
  AppendLogLineInput,
  LogLineContract,
} from "../contracts/task-log-contracts";

/**
 * The **hot path** for live task logs.
 *
 * This is deliberately the only seam that knows *where* in-flight log lines
 * live. Adapters are {@link DrizzleLogFeedStore} (Postgres, the unconfigured
 * default) and {@link DurableObjectLogFeedStore} (a Cloudflare Durable Object
 * per task run, used when `LOG_FEED_URL` and its secrets are set). In the
 * Durable Object setup, workers and browsers also talk to the feed directly
 * over WebSockets; this seam covers the API's side (HTTP fallback writes, CLI
 * reads, archiving and demo seeding).
 *
 *  - The unit of work is a batch of {@link AppendLogLineInput} keyed by a
 *    monotonic per-task `seq` cursor (append) and an offset read (`fromSeq`),
 *    i.e. an append-only log.
 *  - Appends are idempotent on `(taskRunId, seq)`, so retried writes from
 *    the worker can never duplicate lines regardless of backing store.
 *  - `purge` lets the durable archive (object storage) become the source of
 *    truth once a task is terminal: a row delete in Postgres, a seal followed
 *    by a delayed delete in the Durable Object.
 *
 * The `dbExecutor` parameter is Postgres-specific and intentionally optional;
 * non-SQL adapters ignore it. Application code passes it only to participate in
 * an existing transaction (e.g. flushing within task completion).
 */
export interface LogFeedStore {
  /**
   * Append a batch of lines. Returns the highest `seq` durably stored for this
   * task after the batch (the next read cursor). Implementations must
   * treat `(taskRunId, line.seq)` as idempotent.
   */
  append(
    taskRunId: UuidV7,
    lines: AppendLogLineInput[],
    dbExecutor?: DbExecutor,
  ): Promise<{ nextOffset: number }>;

  /**
   * Read lines with `seq > fromSeq`, ordered ascending, capped at `limit`.
   * Returns the lines plus the cursor to use on the next poll.
   */
  read(
    taskRunId: UuidV7,
    fromSeq: number,
    limit: number,
    dbExecutor?: DbExecutor,
  ): Promise<{ lines: LogLineContract[]; nextOffset: number }>;

  /**
   * Read every buffered line in ascending `seq` order. Used to assemble the
   * durable archive at task completion.
   */
  readAll(
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<LogLineContract[]>;

  /**
   * Drop all buffered lines for a task. Called after the lines have
   * been flushed to the durable archive so the hot store stays small. Adapters
   * outside the caller's transaction may instead seal the feed (reject further
   * appends) and delete it later, so a rollback loses nothing.
   */
  purge(taskRunId: UuidV7, dbExecutor?: DbExecutor): Promise<void>;

  /**
   * Sweep buffered lines for tasks that are effectively `abandoned`
   * (their lease or execution deadline lapsed) and were therefore never flushed
   * to the durable archive. Abandonment is DERIVED from the clocks, not
   * persisted, so implementations must reproduce the entity's expiry rule rather
   * than joining on a persisted `abandoned` status. Abandoned logs are
   * intentionally NOT archived, so this simply drops the orphaned hot rows to
   * keep the feed table small.
   *
   * `cutoff` is the grace-window boundary (`now - ABANDONED_LOG_GRACE_MINUTES`):
   * only tasks whose relevant expiry clock lapsed strictly before it are swept
   * (plus legacy persisted-`abandoned` rows whose `completedAt` is before it),
   * so a worker's late flush arriving just after abandonment is not raced.
   * `maxTasks` caps how many distinct tasks a single call processes so
   * the sweeper can be run repeatedly in bounded batches. Returns the number of
   * tasks and lines purged.
   */
  purgeAbandonedFeeds(
    cutoff: Date,
    maxTasks: number,
    dbExecutor?: DbExecutor,
  ): Promise<{ stepsPurged: number; linesPurged: number }>;
}

/**
 * Where workers and browsers connect to a run's live log feed, and the secret
 * their feed tokens are signed with. Null in `AppContext` when the Durable
 * Object feed is not configured.
 */
export type LogFeedConnectionConfig = {
  url: string;
  tokenSecret: string;
};

/** The run's feed has been archived and no longer accepts appends. */
export class LogFeedSealedError extends CoreError {
  constructor(taskRunId: string) {
    super({
      code: "TASK_LOG_FEED_SEALED",
      message: `Log feed for task run ${taskRunId} is sealed`,
      status: 409,
      meta: { taskRunId },
    });
  }
}

/** The run's feed has reached its total-bytes cap and refuses further appends. */
export class LogFeedFullError extends CoreError {
  constructor(taskRunId: string) {
    super({
      code: "TASK_LOG_FEED_FULL",
      message: `Log feed for task run ${taskRunId} is full`,
      status: 413,
      meta: { taskRunId },
    });
  }
}

/** The run's feed refused an append for exceeding its append rate. */
export class LogFeedRateLimitedError extends CoreError {
  constructor(taskRunId: string) {
    super({
      code: "TASK_LOG_FEED_RATE_LIMITED",
      message: `Log feed for task run ${taskRunId} is rate limited`,
      status: 429,
      meta: { taskRunId },
    });
  }
}
