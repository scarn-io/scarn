import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setHomeDirForTests } from "@scarn/sdk/defaults";
import {
  createWorkerHostLogger,
  openWorkerStdioLog,
  workerStdioLogFilePath,
} from "../../../../src/work/worker-host/infra/worker-host-logger";
import { workerLogFilePath } from "../../../../src/work/worker-host/infra/worker-instance-paths";

const instance = "scarn-test";

describe("worker host logger", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "worker-host-logger-"));
    setHomeDirForTests(home);
  });

  afterEach(() => {
    setHomeDirForTests(undefined);
    rmSync(home, { recursive: true, force: true });
  });

  test("writes JSON lines with bound fields to worker.log", () => {
    const host = createWorkerHostLogger({ instance });
    host.logger.child({ projectId: "p1" }).info({ taskRunId: "r1" }, "started");
    host.close();
    const [line] = readFileSync(workerLogFilePath(instance), "utf8")
      .trim()
      .split("\n");
    expect(JSON.parse(line ?? "{}")).toMatchObject({
      msg: "started",
      projectId: "p1",
      taskRunId: "r1",
    });
  });

  test("a new stdio log keeps the previous run's as .1", () => {
    const first = openWorkerStdioLog(instance);
    writeSync(first, "crash\n");
    closeSync(first);
    const second = openWorkerStdioLog(instance);
    writeSync(second, "next\n");
    closeSync(second);
    const filePath = workerStdioLogFilePath(instance);
    expect(readFileSync(filePath, "utf8")).toBe("next\n");
    expect(readFileSync(`${filePath}.1`, "utf8")).toBe("crash\n");
  });
});
