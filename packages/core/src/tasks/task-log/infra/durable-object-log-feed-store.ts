import type { Logger } from "@scarn/observability/logging";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { PersistenceError } from "@scarn/core/lib/errors";
import {
  LogFeedFullError,
  LogFeedRateLimitedError,
  LogFeedSealedError,
  type LogFeedConnectionConfig,
  type LogFeedStore,
} from "../application/log-feed-store";
import type {
  AppendLogLineInput,
  LogLineContract,
} from "../contracts/task-log-contracts";
import { DrizzleLogFeedStore } from "./drizzle-log-feed-store";

const DEFAULT_TIMEOUT_MS = 5000;

/** Mirrors the `TaskRunLogFeed` batch caps in `apps/work-signal/src/log-lines.ts`. */
export const LOG_FEED_MAX_BATCH_LINES = 1_000;
export const LOG_FEED_MAX_BATCH_BYTES = 512 * 1024;

const encoder = new TextEncoder();

/**
 * {@link LogFeedStore} backed by the `TaskRunLogFeed` Durable Object in
 * `apps/work-signal`, one per task run, reached over its bearer-authenticated
 * `/internal/task-runs/:taskRunId/*` routes.
 *
 * - `append` sorts and splits a batch so every request stays within the DO's
 *   line and byte caps; the DO drops lines at or below its highest stored
 *   `seq`, which keeps retries idempotent. A sealed feed throws
 *   {@link LogFeedSealedError}; a feed over its append rate throws
 *   {@link LogFeedRateLimitedError}; a feed at its total-bytes cap throws
 *   {@link LogFeedFullError}.
 * - `purge` seals the feed: the DO rejects further appends and deletes its
 *   storage an hour later, so a rolled-back completion transaction loses
 *   nothing.
 * - `purgeAbandonedFeeds` is a no-op: each DO deletes an abandoned feed on its
 *   own alarm.
 * - The `dbExecutor` parameter is ignored. Timeouts, network errors and
 *   unexpected statuses throw, so callers (and the worker's retrying shipper)
 *   never treat a failed write as stored.
 */
export class DurableObjectLogFeedStore implements LogFeedStore {
  private readonly baseUrl: string;
  private readonly internalSecret: string;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: {
    url: string;
    internalSecret: string;
    logger: Logger;
    timeoutMs?: number;
    fetch?: typeof fetch;
  }) {
    this.baseUrl = options.url.replace(/\/+$/, "");
    this.internalSecret = options.internalSecret;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;
  }

  public async append(
    taskRunId: UuidV7,
    lines: AppendLogLineInput[],
  ): Promise<{ nextOffset: number }> {
    let nextOffset = 0;
    for (const batch of splitIntoBatches(lines)) {
      const response = await this.request(taskRunId, "append", {
        method: "POST",
        body: JSON.stringify({ lines: batch }),
      });
      if (response.status === 409) {
        throw new LogFeedSealedError(taskRunId);
      }
      if (response.status === 429) {
        throw new LogFeedRateLimitedError(taskRunId);
      }
      if (
        response.status === 413 &&
        (await readErrorField(response)) === "feed-full"
      ) {
        throw new LogFeedFullError(taskRunId);
      }
      await this.ensureOk(taskRunId, "append", response);
      ({ nextOffset } = (await response.json()) as { nextOffset: number });
    }
    return { nextOffset };
  }

  public async read(
    taskRunId: UuidV7,
    fromSeq: number,
    limit: number,
  ): Promise<{ lines: LogLineContract[]; nextOffset: number }> {
    const query = new URLSearchParams({
      from: String(fromSeq),
      limit: String(limit),
    });
    const response = await this.request(taskRunId, `read?${query}`, {
      method: "GET",
    });
    await this.ensureOk(taskRunId, "read", response);
    return (await response.json()) as {
      lines: LogLineContract[];
      nextOffset: number;
    };
  }

  public async readAll(taskRunId: UuidV7): Promise<LogLineContract[]> {
    const response = await this.request(taskRunId, "read-all", {
      method: "GET",
    });
    await this.ensureOk(taskRunId, "read-all", response);
    const { lines } = (await response.json()) as { lines: LogLineContract[] };
    return lines;
  }

  public async purge(taskRunId: UuidV7): Promise<void> {
    const response = await this.request(taskRunId, "seal", { method: "POST" });
    await this.ensureOk(taskRunId, "seal", response);
  }

  public purgeAbandonedFeeds(): Promise<{
    stepsPurged: number;
    linesPurged: number;
  }> {
    return Promise.resolve({ stepsPurged: 0, linesPurged: 0 });
  }

  private async request(
    taskRunId: UuidV7,
    path: string,
    init: { method: "GET" | "POST"; body?: string },
  ): Promise<Response> {
    try {
      return await this.fetchImpl(
        `${this.baseUrl}/internal/task-runs/${encodeURIComponent(taskRunId)}/${path}`,
        {
          ...init,
          headers: {
            Authorization: `Bearer ${this.internalSecret}`,
            ...(init.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (error) {
      this.logger.warn({ taskRunId, path, err: error }, "log feed unreachable");
      throw new PersistenceError(
        `Log feed request failed for task run ${taskRunId}`,
        "TASK_LOG_FEED_UNAVAILABLE",
      );
    }
  }

  private async ensureOk(
    taskRunId: UuidV7,
    operation: string,
    response: Response,
  ): Promise<void> {
    if (response.ok) {
      return;
    }
    const detail = await response.text().catch(() => "");
    this.logger.warn(
      { taskRunId, operation, status: response.status, detail },
      "log feed request failed",
    );
    throw new PersistenceError(
      `Log feed ${operation} failed for task run ${taskRunId} (status ${String(response.status)})`,
      "TASK_LOG_FEED_UNAVAILABLE",
    );
  }
}

/** The `error` field of a DO error body, read from a clone so the body stays readable. */
const readErrorField = async (
  response: Response,
): Promise<string | undefined> => {
  try {
    const body = (await response.clone().json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Sorts lines by `seq`, drops duplicate seqs, and splits them into batches the
 * DO accepts: at most {@link LOG_FEED_MAX_BATCH_LINES} lines and a JSON array
 * of at most {@link LOG_FEED_MAX_BATCH_BYTES}. Always yields at least one
 * (possibly empty) batch so an empty append still reports the cursor.
 */
export function splitIntoBatches(
  lines: AppendLogLineInput[],
): AppendLogLineInput[][] {
  const sorted = [...lines].sort((left, right) => left.seq - right.seq);
  const batches: AppendLogLineInput[][] = [];
  let current: AppendLogLineInput[] = [];
  let currentBytes = 2;
  let previousSeq: number | undefined;
  for (const line of sorted) {
    if (line.seq === previousSeq) {
      continue;
    }
    previousSeq = line.seq;
    const lineBytes = encoder.encode(
      JSON.stringify({
        seq: line.seq,
        stream: line.stream,
        ts: line.ts,
        content: line.content,
        level: line.level,
      }),
    ).byteLength;
    const separatorBytes = current.length > 0 ? 1 : 0;
    if (
      current.length > 0 &&
      (current.length >= LOG_FEED_MAX_BATCH_LINES ||
        currentBytes + separatorBytes + lineBytes > LOG_FEED_MAX_BATCH_BYTES)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 2;
    }
    currentBytes += (current.length > 0 ? 1 : 0) + lineBytes;
    current.push(line);
  }
  batches.push(current);
  return batches;
}

type LogFeedEnv = {
  url: string;
  internalSecret: string;
  tokenSecret: string;
};

const readLogFeedEnv = (): LogFeedEnv | null => {
  const url = process.env["LOG_FEED_URL"];
  const internalSecret = process.env["LOG_FEED_INTERNAL_SECRET"];
  const tokenSecret = process.env["LOG_FEED_TOKEN_SECRET"];
  return url && internalSecret && tokenSecret
    ? { url: url.replace(/\/+$/, ""), internalSecret, tokenSecret }
    : null;
};

/**
 * `DurableObjectLogFeedStore` when `LOG_FEED_URL`, `LOG_FEED_INTERNAL_SECRET`
 * and `LOG_FEED_TOKEN_SECRET` are all set; otherwise `DrizzleLogFeedStore`.
 */
export const createLogFeedStoreFromEnv = (logger: Logger): LogFeedStore => {
  const env = readLogFeedEnv();
  return env
    ? new DurableObjectLogFeedStore({
        url: env.url,
        internalSecret: env.internalSecret,
        logger,
      })
    : new DrizzleLogFeedStore();
};

/** Null unless the same three variables {@link createLogFeedStoreFromEnv} needs are set. */
export const resolveLogFeedConnectionFromEnv =
  (): LogFeedConnectionConfig | null => {
    const env = readLogFeedEnv();
    return env ? { url: env.url, tokenSecret: env.tokenSecret } : null;
  };
