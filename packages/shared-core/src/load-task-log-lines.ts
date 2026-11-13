import type {
  LogLine,
  ReadTaskLogsResult,
  Task,
  TaskLogArchive,
} from "./lib/api-types";
import { describeApiError } from "./lib/api-errors";
import type { ApiResult, AuthHeaders } from "./lib/api-result";

/** The two log reads {@link loadTaskLogLines} makes, so any caller holding a
 * generated client (the CLI, the worker) can pass it. */
export type TaskLogsClient = {
  taskRuns: {
    readTaskLogs: (options: {
      path: { taskRunId: string };
      query: { from: number; limit: number };
      headers: AuthHeaders;
    }) => Promise<ApiResult<ReadTaskLogsResult>>;
    getTaskLogArchive: (options: {
      path: { taskRunId: string };
      headers: AuthHeaders;
    }) => Promise<ApiResult<TaskLogArchive>>;
  };
};

export type TaskLogLinesResult =
  { lines: LogLine[]; source: "archive" | "live" } | { unavailable: string };

/**
 * Loads every stream's log lines for a Task: the durable archive once the
 * Task has completed, the live feed while it is still running. API failures
 * come back as `{ unavailable }` with a one-line reason; a failed archive
 * download throws.
 */
export async function loadTaskLogLines(
  client: TaskLogsClient,
  headers: AuthHeaders,
  task: Pick<Task, "id" | "completedAt">,
): Promise<TaskLogLinesResult> {
  if (task.completedAt !== null) {
    const { data, error } = await client.taskRuns.getTaskLogArchive({
      path: { taskRunId: task.id },
      headers,
    });
    if (error !== undefined) {
      if (error.status === 402) {
        return {
          unavailable:
            "log archive read quota exceeded for this org this month (402 USAGE_LIMIT_EXCEEDED_READ). Logs are unavailable until the quota resets.",
        };
      }
      return {
        unavailable: `could not load log archive: ${describeApiError(error)}`,
      };
    }
    if (data.url === null) {
      return {
        unavailable:
          "no log archive is available (not archived yet, or the object store cannot presign a URL).",
      };
    }
    return { lines: await fetchArchiveLogLines(data.url), source: "archive" };
  }

  const live = await readLiveLogLines(client, headers, task.id, 0);
  if ("unavailable" in live) return live;
  return { lines: live.lines, source: "live" };
}

/** The live feed's page size: the API's maximum `limit`. */
export const LIVE_LOG_PAGE_SIZE = 2_000;

/**
 * Reads every live-feed line after `from` (exclusive, a line `seq`), paging
 * until a short page. `nextOffset` is the cursor for the next poll and
 * `complete` is the last page's flag: the run is terminal and archived.
 */
export async function readLiveLogLines(
  client: TaskLogsClient,
  headers: AuthHeaders,
  taskRunId: string,
  from: number,
): Promise<
  | { lines: LogLine[]; nextOffset: number; complete: boolean }
  | { unavailable: string }
> {
  const lines: LogLine[] = [];
  let cursor = from;
  for (;;) {
    const { data, error } = await client.taskRuns.readTaskLogs({
      path: { taskRunId },
      query: { from: cursor, limit: LIVE_LOG_PAGE_SIZE },
      headers,
    });
    if (error !== undefined) {
      return {
        unavailable: `could not load live logs: ${describeApiError(error)}`,
      };
    }
    lines.push(...data.lines);
    const advanced = data.nextOffset > cursor;
    cursor = Math.max(cursor, data.nextOffset);
    if (data.lines.length < LIVE_LOG_PAGE_SIZE || !advanced) {
      return { lines, nextOffset: cursor, complete: data.complete };
    }
  }
}

/**
 * Downloads and parses the NDJSON log archive at a presigned URL.
 * `finalize-task-log.ts` stores the archive gzip-compressed with
 * `Content-Encoding: gzip` (see `object-store.ts`'s `PutObjectInput.compress`
 * doc comment: "HTTP clients fetching via a presigned URL decompress
 * transparently"), so a plain `fetch` already receives decompressed bytes —
 * no manual gunzip needed here. Malformed lines are skipped rather than
 * failing the whole fetch.
 */
async function fetchArchiveLogLines(url: string): Promise<LogLine[]> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download log archive (HTTP ${String(response.status)}).`,
    );
  }
  const text = await response.text();
  const lines: LogLine[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.trim().length === 0) continue;
    try {
      lines.push(JSON.parse(rawLine) as LogLine);
    } catch {
      continue;
    }
  }
  return lines;
}
