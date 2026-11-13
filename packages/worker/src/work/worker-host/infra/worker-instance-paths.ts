/**
 * Filesystem layout for a worker instance: `~/.scarn/workers/<instance>/`
 * holds `worker.json` (discovery) and `worker.log*`. The directory is
 * private to the user (`0700`, files `0600`); on Windows `chmod` is skipped
 * because POSIX modes don't apply there.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveHomeDir } from "@scarn/sdk/defaults";
import { isValidWorkerInstanceName } from "../domain/worker-instance";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export function workersRootDir(): string {
  return path.join(resolveHomeDir(), ".scarn", "workers");
}

export function workerInstanceDir(instance: string): string {
  if (!isValidWorkerInstanceName(instance)) {
    throw new Error(`Invalid worker instance name "${instance}"`);
  }
  return path.join(workersRootDir(), instance);
}

export function workerDiscoveryFilePath(instance: string): string {
  return path.join(workerInstanceDir(instance), "worker.json");
}

export function workerLogFilePath(instance: string): string {
  return path.join(workerInstanceDir(instance), "worker.log");
}

export function ensureWorkerInstanceDir(
  instance: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const dir = workerInstanceDir(instance);
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (platform !== "win32") {
    chmodSync(dir, PRIVATE_DIR_MODE);
  }
  return dir;
}

/** Write `contents` to `filePath` readable only by the current user. */
export function writePrivateFile(
  filePath: string,
  contents: string,
  platform: NodeJS.Platform = process.platform,
): void {
  writeFileSync(filePath, contents, { mode: PRIVATE_FILE_MODE });
  restrictFileMode(filePath, platform);
}

/** Tighten an existing file to `0600` (no-op on Windows). */
export function restrictFileMode(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") {
    chmodSync(filePath, PRIVATE_FILE_MODE);
  }
}
