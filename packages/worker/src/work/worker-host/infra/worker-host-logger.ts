/**
 * Logging for the background worker. Its pino logger writes JSON lines to
 * the instance's rotating `worker.log`; pass {@link WorkerHostLogger.destination}
 * as `dest` to the project worker deps so every project loop logs there too.
 *
 * The process's raw stdout and stderr (crash traces, output that bypasses
 * pino) go to a separate `worker.stdio.log`. A file handed to a child as
 * stdio can't follow `worker.log` across a rotation, so the stdio file is
 * rotated once, when the worker starts, keeping the previous run's copy.
 */
import { existsSync, openSync, renameSync } from "node:fs";
import path from "node:path";
import { createLogger, type Logger } from "@scarn/observability/logging/host";
import {
  RotatingLogDestination,
  type RotatingLogDestinationOptions,
} from "./rotating-log-destination";
import {
  PRIVATE_FILE_MODE,
  ensureWorkerInstanceDir,
  restrictFileMode,
  workerInstanceDir,
  workerLogFilePath,
} from "./worker-instance-paths";

export type WorkerHostLogger = {
  logger: Logger;
  destination: RotatingLogDestination;
  close(): void;
};

export type CreateWorkerHostLoggerOptions = {
  instance: string;
  level?: string | undefined;
} & Pick<
  RotatingLogDestinationOptions,
  "maxBytes" | "maxFiles" | "now" | "platform"
>;

export function createWorkerHostLogger(
  options: CreateWorkerHostLoggerOptions,
): WorkerHostLogger {
  ensureWorkerInstanceDir(options.instance, options.platform);
  const destination = new RotatingLogDestination({
    filePath: workerLogFilePath(options.instance),
    maxBytes: options.maxBytes,
    maxFiles: options.maxFiles,
    now: options.now,
    platform: options.platform,
  });
  const logger = createLogger(
    {
      name: "@scarn/worker-host",
      level: options.level ?? process.env["SCARN_LOG_LEVEL"] ?? "info",
    },
    destination,
  );
  return {
    logger,
    destination,
    close: () => {
      destination.close();
    },
  };
}

export function workerStdioLogFilePath(instance: string): string {
  return path.join(workerInstanceDir(instance), "worker.stdio.log");
}

/**
 * Opens a fresh `worker.stdio.log` for appending and returns its descriptor,
 * to pass as a detached child's stdout and stderr. The previous file is kept
 * as `worker.stdio.log.1`.
 */
export function openWorkerStdioLog(
  instance: string,
  platform: NodeJS.Platform = process.platform,
): number {
  ensureWorkerInstanceDir(instance, platform);
  const filePath = workerStdioLogFilePath(instance);
  if (existsSync(filePath)) renameSync(filePath, `${filePath}.1`);
  const fd = openSync(filePath, "a", PRIVATE_FILE_MODE);
  restrictFileMode(filePath, platform);
  return fd;
}
