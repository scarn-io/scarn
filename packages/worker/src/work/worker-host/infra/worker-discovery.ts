/**
 * The discovery file `~/.scarn/workers/<instance>/worker.json` tells the CLI
 * where a running background worker listens and which token it accepts.
 * The worker writes it once its control server is up (to a temporary file
 * that is then renamed into place, so readers never see half a file) and
 * removes it when it exits.
 */
import { readFileSync, renameSync, rmSync } from "node:fs";
import {
  workerDiscoverySchema,
  type WorkerDiscovery,
  type WorkerHealth,
} from "../contracts/control-api";
import { createControlClient, type ControlClient } from "./control-client";
import {
  ensureWorkerInstanceDir,
  workerDiscoveryFilePath,
  writePrivateFile,
} from "./worker-instance-paths";

export const DEFAULT_DISCOVERY_HEALTH_TIMEOUT_MS = 2_000;

/**
 * The worker's process is alive but its control API did not answer in
 * time. Its discovery file is kept, so the CLI does not start a second
 * worker for the instance.
 */
export class WorkerUnresponsiveError extends Error {
  override readonly name = "WorkerUnresponsiveError";

  constructor(
    readonly instance: string,
    readonly pid: number,
  ) {
    super(
      `Worker instance ${instance} (pid ${String(pid)}) is running but its control API does not answer.`,
    );
  }
}

export type RunningWorker = {
  discovery: WorkerDiscovery;
  client: ControlClient;
  health: WorkerHealth;
};

export type FindRunningWorkerOptions = {
  timeoutMs?: number | undefined;
  isProcessAlive?: ((pid: number) => boolean) | undefined;
};

export function writeWorkerDiscovery(info: WorkerDiscovery): void {
  ensureWorkerInstanceDir(info.instance);
  const filePath = workerDiscoveryFilePath(info.instance);
  const tempPath = `${filePath}.${String(process.pid)}.tmp`;
  writePrivateFile(tempPath, `${JSON.stringify(info, null, 2)}\n`);
  renameSync(tempPath, filePath);
}

/** The discovery file's contents, or null when it is missing or unreadable. */
export function readWorkerDiscovery(instance: string): WorkerDiscovery | null {
  let raw: string;
  try {
    raw = readFileSync(workerDiscoveryFilePath(instance), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = workerDiscoverySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Deletes the discovery file. With `onlyIfPid`, only when the file still
 * names that process, so a worker exiting late never removes the file of
 * the worker that replaced it.
 */
export function removeWorkerDiscovery(
  instance: string,
  options: { onlyIfPid?: number | undefined } = {},
): boolean {
  const filePath = workerDiscoveryFilePath(instance);
  if (options.onlyIfPid !== undefined) {
    const current = readWorkerDiscovery(instance);
    if (current && current.pid !== options.onlyIfPid) return false;
  }
  rmSync(filePath, { force: true });
  return true;
}

/**
 * Finds the worker running for `instance` and checks it over `/health`.
 * Returns null, after deleting the stale file, when nothing answers, the
 * token is refused, the answer is for another instance, or the file is
 * unreadable. Throws {@link WorkerUnresponsiveError} when the health check
 * times out while the file's process is still alive.
 */
export async function findRunningWorker(
  instance: string,
  options: FindRunningWorkerOptions = {},
): Promise<RunningWorker | null> {
  const discovery = readWorkerDiscovery(instance);
  if (!discovery) {
    rmSync(workerDiscoveryFilePath(instance), { force: true });
    return null;
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_HEALTH_TIMEOUT_MS;
  const client = createControlClient({
    port: discovery.port,
    token: discovery.token,
    fetcher: withTimeout(timeoutMs),
  });
  const { data, error } = await client.health.get();
  if (data && data.instance === instance) {
    return {
      discovery,
      client: createControlClient(discovery),
      health: data,
    };
  }
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  if (error && isTimeout(error.value) && isAlive(discovery.pid)) {
    throw new WorkerUnresponsiveError(instance, discovery.pid);
  }
  removeWorkerDiscovery(instance, { onlyIfPid: discovery.pid });
  return null;
}

function withTimeout(timeoutMs: number): typeof fetch {
  const timed = (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return Object.assign(timed, { preconnect: fetch.preconnect });
}

// eslint-disable-next-line local/no-unknown-parameter-type -- Eden reports a failed fetch as an untyped value
function isTimeout(value: unknown): boolean {
  return value instanceof DOMException && value.name === "TimeoutError";
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
