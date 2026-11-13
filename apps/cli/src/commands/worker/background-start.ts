/**
 * `scarn worker start` without `--foreground`: makes sure the instance's
 * background worker is running. When one already answers it reports that;
 * otherwise it spawns this CLI again as `worker start --foreground`,
 * detached, with stdout and stderr going to `worker.stdio.log`, and waits
 * for the new worker's `/health`.
 */
import { spawn } from "node:child_process";
import { closeSync } from "node:fs";
import {
  WorkerUnresponsiveError,
  findRunningWorker,
  openWorkerStdioLog,
  workerLogFilePath,
  workerStdioLogFilePath,
  type RunningWorker,
} from "@scarn/worker";
import { isCompiledStandaloneEntry } from "../../lib/resolve-cli-path";
import {
  WorkerAlreadyRunningError,
  WorkerStartFailedError,
} from "./worker-errors";

export const WORKER_START_TIMEOUT_MS = 15_000;
const WORKER_START_POLL_MS = 200;

export type EnsureWorkerRunningOptions = {
  instance: string;
  baseUrl?: string | undefined;
  maxConcurrency?: number | undefined;
};

export type EnsureWorkerRunningDeps = {
  findRunningWorker?:
    ((instance: string) => Promise<RunningWorker | null>) | undefined;
  spawnWorker?: ((args: string[], instance: string) => void) | undefined;
  timeoutMs?: number | undefined;
  pollMs?: number | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
};

export type EnsureWorkerRunningResult = {
  started: boolean;
  worker: RunningWorker;
  logFilePath: string;
};

/** The command that re-runs this CLI: the binary itself, or bun + the entry script. */
export function selfCommand(
  execPath: string = process.execPath,
  argv: readonly string[] = process.argv,
): string[] {
  const entry = argv[1];
  if (isCompiledStandaloneEntry(entry) || entry === undefined) {
    return [execPath];
  }
  return [execPath, entry];
}

export function foregroundStartArgs(
  options: Pick<EnsureWorkerRunningOptions, "baseUrl" | "maxConcurrency">,
): string[] {
  const args = ["worker", "start", "--foreground"];
  if (options.baseUrl !== undefined) args.push("--base-url", options.baseUrl);
  if (options.maxConcurrency !== undefined) {
    args.push("--max-concurrency", String(options.maxConcurrency));
  }
  return args;
}

/**
 * Spawns the detached worker process. The child inherits the environment,
 * so `SCARN_WORKER_INSTANCE`, `SCARN_CLI_NAME`, `SCARN_LOCAL_DB_PATH`, `HOME`
 * and the rest resolve the same instance and paths.
 */
export function spawnDetachedWorker(args: string[], instance: string): void {
  const [command, ...prefix] = selfCommand();
  if (command === undefined) throw new Error("No CLI command to spawn.");
  const stdio = openWorkerStdioLog(instance);
  try {
    const child = spawn(command, [...prefix, ...args], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdio, stdio],
      env: { ...process.env, SCARN_WORKER_INSTANCE: instance },
    });
    child.unref();
  } finally {
    closeSync(stdio);
  }
}

/**
 * Returns the running worker for the instance, starting it first when none
 * is. Throws {@link WorkerAlreadyRunningError} when a worker's process is
 * alive but does not answer, and {@link WorkerStartFailedError} when a
 * spawned worker does not answer within the timeout.
 */
export async function ensureWorkerRunning(
  options: EnsureWorkerRunningOptions,
  deps: EnsureWorkerRunningDeps = {},
): Promise<EnsureWorkerRunningResult> {
  const { instance } = options;
  const find = deps.findRunningWorker ?? findRunningWorker;
  const logFilePath = workerLogFilePath(instance);
  const existing = await findOrUnresponsive(instance, find);
  if (existing) return { started: false, worker: existing, logFilePath };

  (deps.spawnWorker ?? spawnDetachedWorker)(
    foregroundStartArgs(options),
    instance,
  );

  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (deps.timeoutMs ?? WORKER_START_TIMEOUT_MS);
  while (now() < deadline) {
    await sleep(deps.pollMs ?? WORKER_START_POLL_MS);
    const worker = await find(instance).catch(() => null);
    if (worker) return { started: true, worker, logFilePath };
  }
  throw new WorkerStartFailedError(
    `Worker instance ${instance} did not start within ` +
      `${String(Math.round((deps.timeoutMs ?? WORKER_START_TIMEOUT_MS) / 1000))}s. ` +
      `See ${workerStdioLogFilePath(instance)} and ${logFilePath}.`,
  );
}

async function findOrUnresponsive(
  instance: string,
  find: (instance: string) => Promise<RunningWorker | null>,
): Promise<RunningWorker | null> {
  try {
    return await find(instance);
  } catch (error) {
    if (error instanceof WorkerUnresponsiveError) {
      throw new WorkerAlreadyRunningError(instance, error.pid);
    }
    throw error;
  }
}
