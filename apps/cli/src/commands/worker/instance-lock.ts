/**
 * `~/.scarn/workers/<instance>/worker.lock` makes sure only one foreground
 * worker runs per instance, even when two start at the same moment and
 * neither has written `worker.json` yet.
 *
 * The lock holds the owner's pid. It is created by hard-linking a fully
 * written temporary file into place, which fails when the lock exists, so
 * the check and the claim are one atomic step and a reader never sees an
 * empty lock. A lock whose process is gone is stale and is replaced.
 */
import { linkSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  ensureWorkerInstanceDir,
  isProcessAlive,
  writePrivateFile,
} from "@scarn/worker";

export type InstanceLock = {
  readonly filePath: string;
  release(): void;
};

export type AcquireInstanceLockOptions = {
  pid?: number | undefined;
  isProcessAlive?: ((pid: number) => boolean) | undefined;
};

export function workerLockFilePath(instance: string): string {
  return path.join(ensureWorkerInstanceDir(instance), "worker.lock");
}

/**
 * Takes the instance lock, or returns the pid of the live process holding
 * it.
 */
export function acquireInstanceLock(
  instance: string,
  options: AcquireInstanceLockOptions = {},
): InstanceLock | { heldBy: number } {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isProcessAlive ?? isProcessAlive;
  const filePath = workerLockFilePath(instance);
  const tempPath = `${filePath}.${String(pid)}.tmp`;
  writePrivateFile(tempPath, String(pid));
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (tryLink(tempPath, filePath)) {
        return {
          filePath,
          release: () => {
            if (readLockPid(filePath) === pid)
              rmSync(filePath, { force: true });
          },
        };
      }
      const holder = readLockPid(filePath);
      if (holder !== null && isAlive(holder)) {
        return { heldBy: holder };
      }
      rmSync(filePath, { force: true });
    }
    throw new Error(`Could not take the worker lock at ${filePath}.`);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function isInstanceLock(
  value: InstanceLock | { heldBy: number },
): value is InstanceLock {
  return "release" in value;
}

function tryLink(from: string, to: string): boolean {
  try {
    linkSync(from, to);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function readLockPid(filePath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(filePath, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
