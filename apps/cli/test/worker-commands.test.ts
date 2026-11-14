/**
 * `scarn worker stop|status|logs|config` against a real control server
 * backed by a fake supervisor: the not-running exit code, the version check
 * (and `stop` working across a mismatch), stop waiting for the worker to go
 * away, logs read from disk with filters, and config's `PATCH /config` and
 * its read-only view of the saved settings.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setHomeDirForTests } from "@scarn/sdk/defaults";
import {
  CONTROL_API_PROTOCOL,
  SqliteWorkerSettingsStore,
  startControlServer,
  workerLogFilePath,
  writeWorkerDiscovery,
  type ControlServer,
  type ControlSupervisor,
  type WorkerStatus,
} from "@scarn/worker";
import { rejection } from "./action-harness";
import { run } from "../src/cli";
import { runWorkerConfig } from "../src/commands/worker/config";
import { runWorkerLogs } from "../src/commands/worker/logs";
import { runWorkerStatus } from "../src/commands/worker/status";
import { drainingMessage, runWorkerStop } from "../src/commands/worker/stop";
import {
  WorkerNotRunningError,
  WorkerVersionMismatchError,
} from "../src/commands/worker/worker-errors";
import type { CliError } from "../src/lib/cli-error";
import { resolveWorkerVersion } from "../src/lib/worker-version";
import { FAKE_PROJECT_ID, saveFakeProject } from "./worker-host-fakes";

setDefaultTimeout(20_000);

const INSTANCE = "test-worker-commands";
const OTHER_PROJECT_ID = "01966a2c-9494-7db5-aa46-0f8f5cbbe0ff";

type Call = { method: string; args: unknown[] };

const ACTIVE_RUN = {
  taskRunId: "run-1",
  projectId: FAKE_PROJECT_ID,
  taskName: "Fix the bug",
  phase: "running" as const,
  startedAt: "2026-11-12T00:00:00.000Z",
};

class FakeSupervisor implements ControlSupervisor {
  readonly calls: Call[] = [];
  state: ControlSupervisor["state"] = "running";
  readonly instance = INSTANCE;
  activeRuns: WorkerStatus["activeRuns"] = [];
  stopped = Promise.withResolvers<undefined>();

  addOrUpdateProject() {
    return Promise.resolve({ outcome: "added" as const, project: null });
  }

  removeProject() {
    return { removed: true, drainingRuns: [] };
  }

  setMachineLimit(limit: number) {
    this.calls.push({ method: "setMachineLimit", args: [limit] });
    return { maxConcurrency: limit };
  }

  cancelRun() {
    return { found: false };
  }

  stop(options: { force?: boolean } = {}) {
    this.calls.push({ method: "stop", args: [options] });
    this.state = options.force ? "stopping" : "draining";
    return this.stopped.promise;
  }

  status(options: { recentRuns?: number } = {}): WorkerStatus {
    this.calls.push({ method: "status", args: [options] });
    return {
      instance: this.instance,
      baseUrl: "https://scarn.test",
      state: this.state,
      maxConcurrency: 4,
      slots: {
        machineLimit: 4,
        machineInUse: this.activeRuns.length,
        projects: [
          {
            projectId: FAKE_PROJECT_ID,
            limit: 2,
            inUse: this.activeRuns.length,
          },
        ],
      },
      projects: [
        {
          projectId: FAKE_PROJECT_ID,
          projectRef: "acme/app",
          state: "running",
          errorReason: null,
          errorMessage: null,
          nextRetryAt: null,
          settings: {
            instance: this.instance,
            projectId: FAKE_PROJECT_ID,
            projectRef: "acme/app",
            repoDir: "/repos/app",
            sourceBranch: "main",
            baseUrl: "https://scarn.test",
            addedByUserId: "user-1",
            concurrency: 2,
            workItemId: null,
            preserveRuntime: false,
            createdAt: "2026-11-12T00:00:00.000Z",
            updatedAt: "2026-11-12T00:00:00.000Z",
          },
          activeRuns: this.activeRuns.length,
        },
      ],
      activeRuns: this.activeRuns,
      recentRuns: [],
    };
  }
}

const noSlots = {
  acquire: () => 0,
  release: () => undefined,
  changed: () => new Promise<void>(() => undefined),
};

let home: string;
let databasePath: string;
let supervisor: FakeSupervisor;
let server: ControlServer | undefined;
let previousInstance: string | undefined;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "scarn-worker-commands-"));
  databasePath = path.join(home, "db.sqlite");
  setHomeDirForTests(home);
  previousInstance = process.env["SCARN_WORKER_INSTANCE"];
  process.env["SCARN_WORKER_INSTANCE"] = INSTANCE;
  supervisor = new FakeSupervisor();
  server = undefined;
});

afterEach(async () => {
  supervisor.stopped.resolve(undefined);
  await server?.close({ force: true });
  if (previousInstance === undefined) {
    delete process.env["SCARN_WORKER_INSTANCE"];
  } else {
    process.env["SCARN_WORKER_INSTANCE"] = previousInstance;
  }
  setHomeDirForTests(undefined);
  rmSync(home, { recursive: true, force: true });
});

function startWorker(version: string = resolveWorkerVersion()): ControlServer {
  const started = startControlServer({
    supervisor,
    slots: noSlots,
    version,
    pid: process.pid,
    startedAt: "2026-11-12T00:00:00.000Z",
    logFilePath: path.join(home, "unused.log"),
  });
  writeWorkerDiscovery({
    pid: process.pid,
    port: started.port,
    token: started.token,
    version,
    protocol: CONTROL_API_PROTOCOL,
    instance: INSTANCE,
    baseUrl: "https://scarn.test",
    startedAt: "2026-11-12T00:00:00.000Z",
  });
  server = started;
  return started;
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return chunks.join("");
}

describe("worker status", () => {
  test("fails with exit code 3 when no worker runs", async () => {
    const error = await rejection(
      runWorkerStatus({ json: false, recentRuns: undefined }),
    );
    expect(error).toBeInstanceOf(WorkerNotRunningError);
    expect((error as CliError).exitCode).toBe(3);
    expect(error.message).toContain("not running");
  });

  test("the CLI exits 3 when no worker runs", async () => {
    expect(await run(["worker", "status"])).toBe(3);
  });

  test("prints the health and status as JSON", async () => {
    startWorker();
    supervisor.activeRuns = [ACTIVE_RUN];
    const output = await captureStdout(() =>
      runWorkerStatus({ json: true, recentRuns: 5 }),
    );
    const parsed = JSON.parse(output) as {
      health: { instance: string; version: string };
      status: WorkerStatus;
    };
    expect(parsed.health.instance).toBe(INSTANCE);
    expect(parsed.health.version).toBe(resolveWorkerVersion());
    expect(parsed.status.activeRuns).toEqual([ACTIVE_RUN]);
    expect(supervisor.calls).toContainEqual({
      method: "status",
      args: [{ recentRuns: 5 }],
    });
  });

  test("prints the worker, its projects and active runs", async () => {
    startWorker();
    supervisor.activeRuns = [ACTIVE_RUN];
    const output = await captureStdout(() =>
      runWorkerStatus({ json: false, recentRuns: undefined }),
    );
    expect(output).toContain(`Worker ${INSTANCE}: running`);
    expect(output).toContain("slots 1/4 in use");
    expect(output).toContain("acme/app  running  runs 1/2");
    expect(output).toContain("run-1  acme/app  Fix the bug  running");
  });

  test("refuses a worker of another version", async () => {
    startWorker("0.0.1-old");
    const error = await rejection(
      runWorkerStatus({ json: false, recentRuns: undefined }),
    );
    expect(error).toBeInstanceOf(WorkerVersionMismatchError);
    expect(error.message).toBe(
      `The running worker is version 0.0.1-old; this CLI is ${resolveWorkerVersion()}. ` +
        `Run \`${INSTANCE} worker stop && ${INSTANCE} worker start\`.`,
    );
  });
});

describe("worker stop", () => {
  test("succeeds without a worker", async () => {
    await runWorkerStop({ force: false });
  });

  test("asks the worker to stop and waits until it is gone, even across a version mismatch", async () => {
    const running = startWorker("0.0.1-old");
    supervisor.activeRuns = [ACTIVE_RUN];
    let alive = true;
    const done = runWorkerStop(
      { force: true },
      {
        pollMs: 10,
        isProcessAlive: () => alive,
        subscribeInterrupt: () => () => undefined,
      },
    );
    while (supervisor.calls.filter((c) => c.method === "status").length < 2) {
      await Bun.sleep(10);
    }
    expect(supervisor.calls).toContainEqual({
      method: "stop",
      args: [{ force: true }],
    });
    alive = false;
    await running.close({ force: true });
    server = undefined;
    await done;
  });

  test("Ctrl-C stops the waiting but not the worker", async () => {
    startWorker();
    let interrupt: (() => void) | undefined;
    const done = runWorkerStop(
      { force: false },
      {
        pollMs: 10,
        subscribeInterrupt: (onInterrupt) => {
          interrupt = onInterrupt;
          return () => undefined;
        },
      },
    );
    while (!supervisor.calls.some((c) => c.method === "status")) {
      await Bun.sleep(10);
    }
    interrupt?.();
    await done;
    expect(supervisor.state).toBe("draining");
  });

  test("names the runs still draining", () => {
    expect(drainingMessage([ACTIVE_RUN])).toBe(
      "Draining 1 run: Fix the bug (run-1)",
    );
    expect(drainingMessage([])).toBe("Waiting for the worker to exit…");
  });
});

describe("worker logs", () => {
  const line = (projectId: string, taskRunId: string, msg: string) =>
    JSON.stringify({ level: 30, time: 0, projectId, taskRunId, msg });

  function writeLog(lines: string[]): void {
    const filePath = workerLogFilePath(INSTANCE);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${lines.join("\n")}\n`);
  }

  async function logs(
    args: Partial<Parameters<typeof runWorkerLogs>[0]>,
    isTTY = false,
  ): Promise<string> {
    let output = "";
    await runWorkerLogs(
      { project: undefined, run: undefined, follow: false, tail: 200, ...args },
      {
        openStore: () => new SqliteWorkerSettingsStore({ databasePath }),
        isTTY,
        write: (text) => {
          output += text;
        },
      },
    );
    return output;
  }

  const first = line(FAKE_PROJECT_ID, "run-1", "first");
  const second = line(OTHER_PROJECT_ID, "run-2", "second");
  const third = line(FAKE_PROJECT_ID, "run-3", "third");
  const lines = [first, second, third];

  test("prints raw JSON lines when piped, without a running worker", async () => {
    writeLog(lines);
    expect(await logs({})).toBe(`${lines.join("\n")}\n`);
  });

  test("filters by project ID and run", async () => {
    writeLog(lines);
    expect(await logs({ project: FAKE_PROJECT_ID })).toBe(
      `${first}\n${third}\n`,
    );
    expect(await logs({ run: "run-2" })).toBe(`${second}\n`);
  });

  test("resolves a project ref from the instance's saved projects", async () => {
    writeLog(lines);
    saveFakeProject(databasePath, INSTANCE);
    expect(await logs({ project: "acme/app", run: "run-3" })).toBe(
      `${third}\n`,
    );
    const error = await rejection(logs({ project: "acme/missing" }));
    expect((error as CliError).code).toBe("project_not_found");
  });

  test("pretty-prints in a terminal", async () => {
    writeLog([first]);
    const output = await logs({}, true);
    expect(output).toContain("first");
    expect(output).not.toContain('"msg"');
  });
});

describe("worker config", () => {
  test("changes the machine-wide limit over PATCH /config", async () => {
    startWorker();
    const output = await captureStdout(() =>
      runWorkerConfig({ maxConcurrency: 3 }),
    );
    expect(output).toBe("max-concurrency: 3\n");
    expect(supervisor.calls).toContainEqual({
      method: "setMachineLimit",
      args: [3],
    });
  });

  test("rejects a non-positive limit before connecting", async () => {
    const error = await rejection(runWorkerConfig({ maxConcurrency: 0 }));
    expect((error as CliError).code).toBe("invalid_usage");
  });

  test("checks the worker's version", async () => {
    startWorker("0.0.1-old");
    const error = await rejection(runWorkerConfig({ maxConcurrency: 3 }));
    expect(error).toBeInstanceOf(WorkerVersionMismatchError);
  });

  test("without flags, prints the saved settings, or the defaults, without a running worker", async () => {
    const openStore = () => new SqliteWorkerSettingsStore({ databasePath });
    const show = () =>
      captureStdout(() =>
        runWorkerConfig(
          { maxConcurrency: undefined },
          { openStore, env: { SCARN_WORK_CONCURRENCY: "3" } },
        ),
      );
    expect(await show()).toBe(
      `instance: ${INSTANCE}\nbase-url: (not bound)\nmax-concurrency: 3 (default)\n`,
    );
    const store = openStore();
    store.saveInstance({
      instance: INSTANCE,
      baseUrl: "https://scarn.test",
      maxConcurrency: 5,
    });
    store.close();
    expect(await show()).toBe(
      `instance: ${INSTANCE}\nbase-url: https://scarn.test\nmax-concurrency: 5\n`,
    );
  });
});
