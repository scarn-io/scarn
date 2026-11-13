/**
 * Reads a background worker's log (`worker.log`, pino JSON lines). Lines
 * carry `projectId` and `taskRunId` when they belong to a project or a run,
 * so they can be filtered by either. Used by the control API's `/logs` and
 * by the CLI directly when the worker is not running.
 */
import { stat } from "node:fs/promises";

export type WorkerLogFilter = {
  projectId?: string | undefined;
  taskRunId?: string | undefined;
};

export type FollowWorkerLogOptions = WorkerLogFilter & {
  filePath: string;
  /** Byte offset to start from; the end of a {@link readWorkerLog} result. */
  from: number;
  signal: AbortSignal;
  pollMs?: number | undefined;
};

export const DEFAULT_LOG_POLL_MS = 250;

const NEWLINE = 0x0a;

/** True when a log line belongs to the filter's project and run. */
export function matchesWorkerLogFilter(
  line: string,
  filter: WorkerLogFilter,
): boolean {
  if (filter.projectId === undefined && filter.taskRunId === undefined) {
    return true;
  }
  const fields = parseLogFields(line);
  if (!fields) return false;
  return (
    (filter.projectId === undefined || fields.projectId === filter.projectId) &&
    (filter.taskRunId === undefined || fields.taskRunId === filter.taskRunId)
  );
}

/**
 * The last `tail` matching lines, and the byte offset the file was read up
 * to (pass it to {@link followWorkerLog}). When the live file has fewer than
 * `tail` matches, the rest come from the last rotated file
 * (`worker.log.1`). A missing file has no lines.
 */
export async function readWorkerLog(
  options: WorkerLogFilter & { filePath: string; tail: number },
): Promise<{ lines: string[]; offset: number }> {
  const { lines, end } = await readMatchingLines(options.filePath, options);
  if (options.tail === 0) return { lines: [], offset: end };
  if (lines.length >= options.tail) {
    return { lines: lines.slice(-options.tail), offset: end };
  }
  const rotated = await readMatchingLines(`${options.filePath}.1`, options);
  return {
    lines: [...rotated.lines, ...lines].slice(-options.tail),
    offset: end,
  };
}

async function readMatchingLines(
  filePath: string,
  filter: WorkerLogFilter,
): Promise<{ lines: string[]; end: number }> {
  const size = await fileSize(filePath);
  if (size === 0) return { lines: [], end: 0 };
  const bytes = new Uint8Array(
    await Bun.file(filePath).slice(0, size).arrayBuffer(),
  );
  const end = bytes.lastIndexOf(NEWLINE) + 1;
  const lines = splitLines(bytes.subarray(0, end)).filter((line) =>
    matchesWorkerLogFilter(line, filter),
  );
  return { lines, end };
}

/**
 * Yields matching lines appended to the log after `from`, until `signal`
 * aborts. Polls the file size; when the file shrinks (it was rotated), it
 * starts again from the top of the new file.
 */
export async function* followWorkerLog(
  options: FollowWorkerLogOptions,
): AsyncGenerator<string> {
  const pollMs = options.pollMs ?? DEFAULT_LOG_POLL_MS;
  let offset = options.from;
  while (!options.signal.aborted) {
    const size = await fileSize(options.filePath);
    if (size < offset) offset = 0;
    if (size > offset) {
      const bytes = new Uint8Array(
        await Bun.file(options.filePath).slice(offset, size).arrayBuffer(),
      );
      const end = bytes.lastIndexOf(NEWLINE) + 1;
      offset += end;
      for (const line of splitLines(bytes.subarray(0, end))) {
        if (matchesWorkerLogFilter(line, options)) yield line;
      }
    }
    await sleep(pollMs, options.signal);
  }
}

function splitLines(bytes: Uint8Array): string[] {
  return new TextDecoder()
    .decode(bytes)
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function parseLogFields(
  line: string,
): { projectId?: unknown; taskRunId?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timeout = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
