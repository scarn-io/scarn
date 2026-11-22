import { and, asc, eq, exists, gt, inArray, lt, max, or } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { taskLogLines, taskRuns } from "@scarn/core/lib/db/schema";
import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { LogFeedStore } from "../application/log-feed-store";
import type {
  AppendLogLineInput,
  LogLineContract,
} from "../contracts/task-log-contracts";

const toContract = (
  row: typeof taskLogLines.$inferSelect,
): LogLineContract => ({
  seq: row.seq,
  stream: row.stream,
  ts: row.ts.toISOString(),
  content: row.content,
  level: row.level,
});

/**
 * Strip bytes PostgreSQL `text` cannot store before insert. NUL bytes (and, on
 * some drivers, other C0 controls) abort the whole batch INSERT with
 * `invalid byte sequence for encoding "UTF8": 0x00`. Workers sanitize before
 * shipping, but this is the last line of defense so no client can poison the
 * feed table and stall the feed. Lone UTF-16 surrogates are replaced with the
 * replacement character.
 */
const sanitizeContent = (content: string): string =>
  content
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/[\uD800-\uDFFF]/g, "\uFFFD");

/**
 * Postgres adapter for the live log feed. The feed table is treated as a
 * transient ring buffer; rows are pruned by {@link purge} once flushed to the
 * durable archive. This is the only place that knows the hot path is SQL — see
 * {@link LogFeedStore} for the seam that lets this be swapped for Redis later.
 */
export class DrizzleLogFeedStore implements LogFeedStore {
  async append(
    taskRunId: UuidV7,
    lines: AppendLogLineInput[],
    dbExecutor?: DbExecutor,
  ): Promise<{ nextOffset: number }> {
    const db = dbExecutor ?? getDb();
    if (lines.length > 0) {
      await db
        .insert(taskLogLines)
        .values(
          lines.map((line) => ({
            id: createUuidV7(),
            taskRunId: taskRunId,
            seq: line.seq,
            stream: line.stream,
            ts: new Date(line.ts),
            content: sanitizeContent(line.content),
            level: line.level,
          })),
        )
        // Idempotent on (taskRunId, seq): retried worker batches no-op.
        .onConflictDoNothing({
          target: [taskLogLines.taskRunId, taskLogLines.seq],
        });
    }
    return { nextOffset: await this.highestSeq(taskRunId, db) };
  }

  async read(
    taskRunId: UuidV7,
    fromSeq: number,
    limit: number,
    dbExecutor?: DbExecutor,
  ): Promise<{ lines: LogLineContract[]; nextOffset: number }> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(taskLogLines)
      .where(
        and(
          eq(taskLogLines.taskRunId, taskRunId),
          gt(taskLogLines.seq, fromSeq),
        ),
      )
      .orderBy(asc(taskLogLines.seq))
      .limit(limit);
    const lines = rows.map(toContract);
    const nextOffset =
      lines.length > 0 ? (lines[lines.length - 1]?.seq ?? fromSeq) : fromSeq;
    return { lines, nextOffset };
  }

  async readAll(
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<LogLineContract[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(taskLogLines)
      .where(eq(taskLogLines.taskRunId, taskRunId))
      .orderBy(asc(taskLogLines.seq));
    return rows.map(toContract);
  }

  async purge(taskRunId: UuidV7, dbExecutor?: DbExecutor): Promise<void> {
    const db = dbExecutor ?? getDb();
    await db.delete(taskLogLines).where(eq(taskLogLines.taskRunId, taskRunId));
  }

  async purgeAbandonedFeeds(
    cutoff: Date,
    maxTasks: number,
    dbExecutor?: DbExecutor,
  ): Promise<{ stepsPurged: number; linesPurged: number }> {
    const db = dbExecutor ?? getDb();

    // Resolve a bounded set of abandoned task ids that still have feed rows.
    // Abandonment is DERIVED, not persisted (see TaskRunEntity's `status`
    // getter): a lapsed task's column still reads `running`, so we reproduce the
    // getter's clock arithmetic in SQL rather than joining on the persisted
    // status. Eligibility:
    //   - status = 'abandoned' AND completed_at < cutoff   -- legacy rows only
    //   - status = 'running'   AND lease_expires_at < cutoff
    //   - status = 'running'   AND execution_deadline_at < cutoff
    // The legacy arm still exists because pre-Phase-2 rows were persisted as
    // `abandoned` with their lease nulled (`clearClaim`), so derivation cannot
    // see them; they DID get a `completed_at`, so that arm gates on it. Both
    // derived arms gate on the expiry clock rather than `completed_at` (which is
    // never written for a derived-abandoned task), so the grace window runs from
    // when the lease/deadline actually lapsed — not from when a row happened to
    // be loaded. A task whose lease lapsed within the grace window (expiry >=
    // cutoff) is left alone, so a worker's late flush is never raced.
    //
    // The `exists` guard restricts the batch to task runs that STILL have feed rows
    // to delete. Without it, a task can satisfy the timing criteria
    // above forever (rows are never deleted from `tasks`, only their
    // log lines are), so once a task's feed has already been purged it would
    // keep occupying LIMIT slots on every future call for no reason. Worse, the
    // batch loop below stops as soon as a batch deletes zero lines — with no
    // ordering on this query, a large-enough backlog of already-clean abandoned
    // task runs can keep landing in every batch's LIMIT window ahead of task runs that
    // still have real orphaned lines, starving them out indefinitely. Filtering
    // on existence keeps `stepsPurged` a true "no more work" signal and bounds
    // each batch to task runs this call can actually make progress on.
    const abandonedTasks = await db
      .select({ id: taskRuns.id })
      .from(taskRuns)
      .where(
        and(
          or(
            and(
              eq(taskRuns.status, "abandoned"),
              lt(taskRuns.completedAt, cutoff),
            ),
            and(
              eq(taskRuns.status, "running"),
              lt(taskRuns.leaseExpiresAt, cutoff),
            ),
            and(
              eq(taskRuns.status, "running"),
              lt(taskRuns.executionDeadlineAt, cutoff),
            ),
          ),
          exists(
            db
              .select({ id: taskLogLines.id })
              .from(taskLogLines)
              .where(eq(taskLogLines.taskRunId, taskRuns.id)),
          ),
        ),
      )
      .limit(maxTasks);

    const taskIds = abandonedTasks.map((row) => row.id);
    if (taskIds.length === 0) {
      return { stepsPurged: 0, linesPurged: 0 };
    }

    const deleted = await db
      .delete(taskLogLines)
      .where(inArray(taskLogLines.taskRunId, taskIds))
      .returning({ taskRunId: taskLogLines.taskRunId });

    // A task counts as "purged" only when it actually had feed rows removed, so
    // repeated runs over already-clean abandoned task runs report zero progress.
    const stepsPurged = new Set(deleted.map((row) => row.taskRunId)).size;

    return { stepsPurged, linesPurged: deleted.length };
  }

  private async highestSeq(taskRunId: UuidV7, db: DbExecutor): Promise<number> {
    const [row] = await db
      .select({ value: max(taskLogLines.seq) })
      .from(taskLogLines)
      .where(eq(taskLogLines.taskRunId, taskRunId));
    return row?.value ?? 0;
  }
}
