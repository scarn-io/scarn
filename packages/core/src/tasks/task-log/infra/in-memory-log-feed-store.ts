import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { LogFeedStore } from "../application/log-feed-store";
import type {
  AppendLogLineInput,
  LogLineContract,
} from "../contracts/task-log-contracts";

/**
 * In-memory {@link LogFeedStore} for unit tests. Mirrors the Postgres adapter's
 * idempotency-on-seq and offset-read semantics so application logic can be
 * tested without a database. Demonstrates that the hot-path seam is genuinely
 * storage-agnostic (a Redis adapter would look similar).
 */
export class InMemoryLogFeedStore implements LogFeedStore {
  private readonly byTask = new Map<string, Map<number, LogLineContract>>();

  // eslint-disable-next-line @typescript-eslint/require-await
  async append(
    taskRunId: UuidV7,
    lines: AppendLogLineInput[],
  ): Promise<{ nextOffset: number }> {
    const bucket = this.bucket(taskRunId);
    for (const line of lines) {
      if (!bucket.has(line.seq)) {
        bucket.set(line.seq, { ...line });
      }
    }
    return { nextOffset: this.highestSeq(bucket) };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async read(
    taskRunId: UuidV7,
    fromSeq: number,
    limit: number,
  ): Promise<{ lines: LogLineContract[]; nextOffset: number }> {
    const all = this.sorted(this.bucket(taskRunId));
    const lines = all.filter((line) => line.seq > fromSeq).slice(0, limit);
    const nextOffset =
      lines.length > 0 ? (lines[lines.length - 1]?.seq ?? fromSeq) : fromSeq;
    return { lines, nextOffset };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async readAll(taskRunId: UuidV7): Promise<LogLineContract[]> {
    return this.sorted(this.bucket(taskRunId));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async purge(taskRunId: UuidV7): Promise<void> {
    this.byTask.delete(taskRunId);
  }

  /**
   * No-op in the in-memory double: resolving which tasks are
   * abandoned means reproducing the entity's expiry rule against the
   * `tasks` clocks (`lease_expires_at` / `execution_deadline_at`, plus
   * legacy persisted-`abandoned` rows), which only the Postgres adapter can do.
   * Application code that needs the sweep is covered by the Drizzle adapter's
   * integration test; here we satisfy the interface and report no progress so
   * callers' batch loops terminate.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async purgeAbandonedFeeds(): Promise<{
    stepsPurged: number;
    linesPurged: number;
  }> {
    return { stepsPurged: 0, linesPurged: 0 };
  }

  private bucket(taskRunId: UuidV7): Map<number, LogLineContract> {
    const existing = this.byTask.get(taskRunId);
    if (existing) {
      return existing;
    }
    const created = new Map<number, LogLineContract>();
    this.byTask.set(taskRunId, created);
    return created;
  }

  private sorted(bucket: Map<number, LogLineContract>): LogLineContract[] {
    return [...bucket.values()].sort((left, right) => left.seq - right.seq);
  }

  private highestSeq(bucket: Map<number, LogLineContract>): number {
    let highest = 0;
    for (const seq of bucket.keys()) {
      if (seq > highest) {
        highest = seq;
      }
    }
    return highest;
  }
}
