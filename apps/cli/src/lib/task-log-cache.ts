import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FullLogSaver } from "@scarn/shared-core";

/**
 * Where the CLI saves a task run's full, uncapped log. A sibling of
 * `LOG_DIR` (`logger.ts`) rather than nested inside it — that directory is
 * the CLI's own diagnostic pino output, a different concern.
 */
function resolveTaskLogCacheDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".scarn", "task-logs");
}

export const TASK_LOG_CACHE_DIR = resolveTaskLogCacheDir();

export async function ensureTaskLogCacheDir(
  dir: string = TASK_LOG_CACHE_DIR,
): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Builds the disk-backed {@link FullLogSaver}. Every call overwrites any
 * existing file for the same `taskRunId`/stream. Failures propagate; the
 * caller decides how to report a log that could not be saved.
 */
export function createFullLogSaver(
  cacheDir: string = TASK_LOG_CACHE_DIR,
): FullLogSaver {
  return async ({ taskRunId, requestedStream, fullText }) => {
    await ensureTaskLogCacheDir(cacheDir);
    const filePath = path.join(cacheDir, `${taskRunId}-${requestedStream}.log`);
    await writeFile(filePath, fullText, "utf8");
    return filePath;
  };
}
