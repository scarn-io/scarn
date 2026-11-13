/**
 * A pino destination for the background worker's `worker.log` that rotates
 * itself, with no external `logrotate`. Writes are synchronous so a line is
 * on disk before the next one starts, even when the process crashes.
 *
 * The live file rotates before a write that would take it past `maxBytes`,
 * or the first write on a new local day. Rotation closes the file before
 * renaming it (Windows can't rename an open file), shifts
 * `worker.log.<n>` to `worker.log.<n+1>`, moves `worker.log` to
 * `worker.log.1` and opens a fresh `worker.log`. `maxFiles` counts every
 * file kept, the live one included, so the default keeps `worker.log` and
 * `worker.log.1` … `worker.log.9`.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import type { DestinationStream } from "pino";
import { PRIVATE_FILE_MODE, restrictFileMode } from "./worker-instance-paths";

export const DEFAULT_LOG_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_LOG_MAX_FILES = 10;

export type RotatingLogDestinationOptions = {
  filePath: string;
  maxBytes?: number | undefined;
  /** Files kept, the live file included. At least 1. */
  maxFiles?: number | undefined;
  now?: (() => Date) | undefined;
  platform?: NodeJS.Platform | undefined;
};

/** `worker.log.<index>`; index 0 is the live file. */
export function rotatedLogFilePath(filePath: string, index: number): string {
  return index === 0 ? filePath : `${filePath}.${String(index)}`;
}

function localDay(date: Date): string {
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1)}-${String(date.getDate())}`;
}

export class RotatingLogDestination implements DestinationStream {
  readonly filePath: string;
  readonly #maxBytes: number;
  readonly #maxFiles: number;
  readonly #now: () => Date;
  readonly #platform: NodeJS.Platform;
  #fd: number | undefined;
  #size = 0;
  #day = "";

  constructor(options: RotatingLogDestinationOptions) {
    this.filePath = options.filePath;
    this.#maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
    this.#maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_LOG_MAX_FILES);
    this.#now = options.now ?? (() => new Date());
    this.#platform = options.platform ?? process.platform;
    this.#open(this.#existingFileDay());
  }

  /** The live file's descriptor; changes on every rotation. */
  get fd(): number {
    if (this.#fd === undefined) throw new Error("Log destination is closed.");
    return this.#fd;
  }

  get closed(): boolean {
    return this.#fd === undefined;
  }

  write(message: string): void {
    if (this.#fd === undefined) return;
    const bytes = Buffer.from(message);
    if (
      (this.#size > 0 && this.#size + bytes.length > this.#maxBytes) ||
      localDay(this.#now()) !== this.#day
    ) {
      this.rotate();
    }
    const fd = this.fd;
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written);
    }
    this.#size += bytes.length;
  }

  /** Rotates now, whatever the size or day. */
  rotate(): void {
    this.#closeFd();
    const oldest = rotatedLogFilePath(this.filePath, this.#maxFiles - 1);
    rmSync(oldest, { force: true });
    for (let index = this.#maxFiles - 2; index >= 0; index -= 1) {
      const from = rotatedLogFilePath(this.filePath, index);
      if (existsSync(from)) {
        renameSync(from, rotatedLogFilePath(this.filePath, index + 1));
      }
    }
    this.#open(undefined);
  }

  close(): void {
    this.#closeFd();
  }

  #existingFileDay(): string | undefined {
    try {
      const stats = statSync(this.filePath);
      return stats.size > 0 ? localDay(stats.mtime) : undefined;
    } catch {
      return undefined;
    }
  }

  #open(day: string | undefined): void {
    const fd = openSync(this.filePath, "a", PRIVATE_FILE_MODE);
    restrictFileMode(this.filePath, this.#platform);
    this.#fd = fd;
    this.#size = fstatSync(fd).size;
    this.#day = day ?? localDay(this.#now());
  }

  #closeFd(): void {
    if (this.#fd === undefined) return;
    closeSync(this.#fd);
    this.#fd = undefined;
  }
}
