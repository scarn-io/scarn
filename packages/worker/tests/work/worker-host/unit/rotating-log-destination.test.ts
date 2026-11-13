import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  RotatingLogDestination,
  rotatedLogFilePath,
} from "../../../../src/work/worker-host/infra/rotating-log-destination";
import { readWorkerLog } from "../../../../src/work/worker-host/infra/worker-log-reader";

describe("RotatingLogDestination", () => {
  let dir: string;
  let filePath: string;
  let now: Date;
  let destination: RotatingLogDestination | undefined;

  const open = (options: { maxBytes?: number; maxFiles?: number } = {}) => {
    destination = new RotatingLogDestination({
      filePath,
      now: () => now,
      ...options,
    });
    return destination;
  };
  const read = (index: number) =>
    readFileSync(rotatedLogFilePath(filePath, index), "utf8");

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "rotating-log-"));
    filePath = path.join(dir, "worker.log");
    now = new Date(2026, 10, 12, 10, 0, 0);
  });

  afterEach(() => {
    destination?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("appends lines to the live file, private to the user", () => {
    const log = open();
    log.write("a\n");
    log.write("b\n");
    expect(read(0)).toBe("a\nb\n");
    if (process.platform !== "win32") {
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  test("rotates before a write that would exceed maxBytes", () => {
    const log = open({ maxBytes: 6 });
    log.write("aaa\n");
    log.write("bbb\n");
    log.write("ccc\n");
    expect(read(0)).toBe("ccc\n");
    expect(read(1)).toBe("bbb\n");
    expect(read(2)).toBe("aaa\n");
  });

  test("writes a line larger than maxBytes to an empty file", () => {
    const log = open({ maxBytes: 2 });
    log.write("long line\n");
    expect(read(0)).toBe("long line\n");
    expect(existsSync(rotatedLogFilePath(filePath, 1))).toBe(false);
  });

  test("rotates when the local day changes", () => {
    const log = open();
    log.write("monday\n");
    now = new Date(2026, 10, 13, 0, 0, 1);
    log.write("tuesday\n");
    expect(read(0)).toBe("tuesday\n");
    expect(read(1)).toBe("monday\n");
  });

  test("keeps maxFiles files, the live one included", () => {
    const log = open({ maxBytes: 1, maxFiles: 3 });
    for (const line of ["1\n", "2\n", "3\n", "4\n", "5\n"]) log.write(line);
    expect(read(0)).toBe("5\n");
    expect(read(1)).toBe("4\n");
    expect(read(2)).toBe("3\n");
    expect(existsSync(rotatedLogFilePath(filePath, 3))).toBe(false);
  });

  test("appends to an existing file from today and rotates one from an earlier day", () => {
    writeFileSync(filePath, "earlier\n");
    utimesSync(filePath, now, now);
    const today = open();
    today.write("today\n");
    today.close();
    expect(read(0)).toBe("earlier\ntoday\n");

    const yesterday = new Date(2026, 10, 11, 12, 0, 0);
    utimesSync(filePath, yesterday, yesterday);
    const log = open();
    log.write("fresh\n");
    expect(read(0)).toBe("fresh\n");
    expect(read(1)).toBe("earlier\ntoday\n");
  });

  test("ignores writes once closed", () => {
    const log = open();
    log.close();
    log.write("late\n");
    expect(read(0)).toBe("");
    expect(log.closed).toBe(true);
  });

  test("readWorkerLog tops the tail up from the last rotated file", async () => {
    const line = (msg: string) => `${JSON.stringify({ msg })}\n`;
    const log = open({ maxBytes: 30 });
    for (const msg of ["a", "b", "c", "d"]) log.write(line(msg));
    log.close();
    expect(read(0)).toBe(line("c") + line("d"));

    const { lines, offset } = await readWorkerLog({ filePath, tail: 3 });
    expect(
      lines.map((entry) => (JSON.parse(entry) as { msg: string }).msg),
    ).toEqual(["b", "c", "d"]);
    expect(offset).toBe(read(0).length);
  });
});
