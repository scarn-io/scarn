import { describeApiError } from "./lib/api-errors";
import type { AuthHeaders } from "./lib/api-result";
import type { LogLine, TaskLogStream } from "./lib/api-types";
import type { TaskRunDetail } from "./lib/task-api-types";
import type { TaskRunDebugClient } from "./lib/task-run-debug-client";
import { loadTaskLogLines, readLiveLogLines } from "./load-task-log-lines";

/**
 * The reads behind `scarn logs`: resolve a Task run (directly, or as a
 * Task's latest or numbered run), load its log lines, and poll the live feed
 * for `--follow`. `./format-task-run-logs.ts` renders the result.
 */

export type ResolveTaskRunOptions = {
  client: TaskRunDebugClient;
  headers: AuthHeaders;
  /** A Task run id, or a Task id. */
  id: string;
  /** Picks this run number of the Task; `id` must then be a Task id. */
  runNumber?: number;
};

/**
 * Resolves `id` to a Task run: the run itself when it is a Task run id,
 * otherwise the Task's latest run (or run `runNumber`).
 */
export async function resolveTaskRun(
  options: ResolveTaskRunOptions,
): Promise<TaskRunDetail> {
  const { client, headers, id, runNumber } = options;
  if (runNumber === undefined) {
    const direct = await client.taskRuns.getTaskRun({
      path: { taskRunId: id },
      headers,
    });
    if (direct.error === undefined) return direct.data;
    if (direct.error.status !== 404) {
      throw new Error(
        `Could not load Task run ${id}: ${describeApiError(direct.error)}`,
      );
    }
  }

  const runs = await client.tasks.getTaskRuns({
    path: { taskId: id },
    headers,
  });
  if (runs.error?.status === 404) {
    throw new Error(
      runNumber === undefined
        ? `No Task run or Task with id ${id}.`
        : `Task ${id} not found (--run needs a Task id).`,
    );
  }
  if (runs.error !== undefined) {
    throw new Error(
      `Could not load the runs of Task ${id}: ${describeApiError(runs.error)}`,
    );
  }
  if (runs.data.length === 0) throw new Error(`Task ${id} has no runs yet.`);

  const sorted = [...runs.data].sort(
    (left, right) => left.number - right.number,
  );
  const picked =
    runNumber === undefined
      ? sorted.at(-1)
      : sorted.find((run) => run.number === runNumber);
  if (picked === undefined) {
    const numbers = sorted.map((run) => String(run.number)).join(", ");
    throw new Error(
      `Task ${id} has no run #${String(runNumber)} (runs: ${numbers}).`,
    );
  }
  return picked;
}

export type GatheredTaskRunLogs = {
  run: TaskRunDetail;
  /** Where the lines came from: the archive once the run has finished, the
   * live feed while it runs (or before a finished run is archived). */
  source: "archive" | "live";
  requestedStream: TaskLogStream | "all";
  /** The run's lines on the requested stream(s), in `seq` order. */
  lines: LogLine[];
  /** The live-feed cursor to follow from (the highest `seq` read). */
  nextOffset: number;
};

/** Keeps the lines of one stream, or every line for `"all"`. */
export function filterByStream(
  lines: readonly LogLine[],
  stream: TaskLogStream | "all",
): LogLine[] {
  return stream === "all"
    ? [...lines]
    : lines.filter((line) => line.stream === stream);
}

function highestSeq(lines: readonly LogLine[]): number {
  return lines.reduce((highest, line) => Math.max(highest, line.seq), 0);
}

/**
 * Loads a Task run's log lines. A finished run whose archive is not
 * available yet falls back to the live feed; if that is empty too, the
 * archive's reason is the error.
 */
export async function gatherTaskRunLogs(options: {
  client: TaskRunDebugClient;
  headers: AuthHeaders;
  run: TaskRunDetail;
  stream: TaskLogStream | "all";
}): Promise<GatheredTaskRunLogs> {
  const { client, headers, run, stream } = options;
  const loaded = await loadTaskLogLines(client, headers, {
    id: run.id,
    completedAt: run.completedAt,
  });
  if (!("unavailable" in loaded)) {
    return {
      run,
      source: loaded.source,
      requestedStream: stream,
      lines: filterByStream(loaded.lines, stream),
      nextOffset: highestSeq(loaded.lines),
    };
  }
  if (run.completedAt !== null) {
    const live = await readLiveLogLines(client, headers, run.id, 0);
    if (!("unavailable" in live) && live.lines.length > 0) {
      return {
        run,
        source: "live",
        requestedStream: stream,
        lines: filterByStream(live.lines, stream),
        nextOffset: live.nextOffset,
      };
    }
  }
  throw new Error(`Logs for Task run ${run.id}: ${loaded.unavailable}`);
}

/** How often `--follow` polls the live feed. */
export const FOLLOW_INTERVAL_MS = 2_000;

export type FollowTaskRunLogsOptions = {
  client: TaskRunDebugClient;
  headers: AuthHeaders;
  taskRunId: string;
  stream: TaskLogStream | "all";
  /** The cursor to start after, from {@link GatheredTaskRunLogs.nextOffset}. */
  from: number;
  sleep: (ms: number) => Promise<void>;
  intervalMs?: number;
  /** Receives each poll's new lines on the requested stream(s). */
  onLines: (lines: LogLine[]) => void;
};

/**
 * Polls the live feed after `from` every `intervalMs` until the run is
 * terminal and archived. Resolves to every line it read.
 */
export async function followTaskRunLogs(
  options: FollowTaskRunLogsOptions,
): Promise<LogLine[]> {
  const { client, headers, taskRunId, stream, sleep, onLines } = options;
  const intervalMs = options.intervalMs ?? FOLLOW_INTERVAL_MS;
  const followed: LogLine[] = [];
  let cursor = options.from;
  for (;;) {
    const page = await readLiveLogLines(client, headers, taskRunId, cursor);
    if ("unavailable" in page) throw new Error(page.unavailable);
    cursor = page.nextOffset;
    const lines = filterByStream(page.lines, stream);
    followed.push(...lines);
    if (lines.length > 0) onLines(lines);
    if (page.complete) return followed;
    await sleep(intervalMs);
  }
}
