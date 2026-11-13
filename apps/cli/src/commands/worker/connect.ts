/**
 * Connecting the `scarn worker …` commands to the instance's running
 * background worker. Every command except `start` and `logs` checks that the
 * worker runs this CLI's version and control-API protocol; `stop` connects
 * without the check so the suggested remedy for a mismatch
 * (`worker stop && worker start`) always works.
 */
import {
  WorkerUnresponsiveError,
  findRunningWorker,
  type RunningWorker,
} from "@scarn/worker";
import {
  CONTROL_API_PROTOCOL,
  resolveWorkerVersion,
} from "../../lib/worker-version";
import {
  WorkerNotRunningError,
  WorkerRequestFailedError,
  WorkerUnresponsiveCliError,
  WorkerVersionMismatchError,
} from "./worker-errors";

export type ConnectToWorkerOptions = {
  checkVersion: boolean;
};

export type ConnectToWorkerDeps = {
  findRunningWorker?:
    ((instance: string) => Promise<RunningWorker | null>) | undefined;
  version?: string | undefined;
  protocol?: number | undefined;
};

/**
 * The running worker for `instance`, or null when none runs. Throws
 * {@link WorkerUnresponsiveCliError} when its process is alive but does not
 * answer, and, with `checkVersion`, {@link WorkerVersionMismatchError} when
 * it runs another version or protocol.
 */
export async function connectToWorker(
  instance: string,
  options: ConnectToWorkerOptions,
  deps: ConnectToWorkerDeps = {},
): Promise<RunningWorker | null> {
  const find = deps.findRunningWorker ?? findRunningWorker;
  let worker: RunningWorker | null;
  try {
    worker = await find(instance);
  } catch (error) {
    if (error instanceof WorkerUnresponsiveError) {
      throw new WorkerUnresponsiveCliError(instance, error.pid);
    }
    throw error;
  }
  if (worker && options.checkVersion) {
    assertWorkerVersion(instance, worker, deps);
  }
  return worker;
}

/** Throws {@link WorkerVersionMismatchError} when `worker` runs another version or protocol than this CLI. */
export function assertWorkerVersion(
  instance: string,
  worker: RunningWorker,
  deps: Pick<ConnectToWorkerDeps, "version" | "protocol"> = {},
): void {
  const version = deps.version ?? resolveWorkerVersion();
  const protocol = deps.protocol ?? CONTROL_API_PROTOCOL;
  if (
    worker.health.version !== version ||
    worker.health.protocol !== protocol
  ) {
    throw new WorkerVersionMismatchError(
      instance,
      worker.health.version,
      version,
    );
  }
}

/** Like {@link connectToWorker}, but throws {@link WorkerNotRunningError} (exit 3) when none runs. */
export async function requireRunningWorker(
  instance: string,
  options: ConnectToWorkerOptions,
  deps: ConnectToWorkerDeps = {},
): Promise<RunningWorker> {
  const worker = await connectToWorker(instance, options, deps);
  if (!worker) throw new WorkerNotRunningError(instance);
  return worker;
}

type EdenResult<T> = {
  data: T | null;
  error: { status: unknown; value: unknown } | null;
};

/**
 * The data of a control-API call, or a {@link WorkerRequestFailedError}
 * carrying the worker's error message.
 */
export async function controlData<T>(
  what: string,
  request: Promise<EdenResult<T>>,
): Promise<T> {
  const { data, error } = await request;
  if (error || data === null) {
    throw new WorkerRequestFailedError(what, error?.value);
  }
  return data;
}
