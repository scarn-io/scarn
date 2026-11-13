/**
 * `scarn worker start`: the foreground host refuses a second worker for an
 * instance, replaces a stale `worker.json`, drains on the first signal and
 * forces on the second, and binds the instance's base URL; `--once` runs a
 * single pass and saves nothing.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { setHomeDirForTests } from "@scarn/sdk/defaults";
import {
  SqliteLocalRuntimeSessionStore,
  SqliteWorkerSettingsStore,
  WorkerSupervisor,
  createWorkerHostLogger,
  noopReporter,
  startControlServer,
  workerDiscoveryFilePath,
  writeWorkerDiscovery,
  type ControlServer,
  type ProcessProjectWorkOptions,
} from "@scarn/worker";
import { rejection } from "./action-harness";
import {
  runForegroundWorker,
  type ForegroundWorkerDeps,
} from "../src/commands/worker/foreground-host";
import { acquireInstanceLock } from "../src/commands/worker/instance-lock";
import { runWorkerOnce } from "../src/commands/worker/run-once";
import { WorkerAlreadyRunningError } from "../src/commands/worker/worker-errors";
import { createCliLogger } from "../src/lib/logger";
import { cliProjectRoot } from "./utils";
import {
  FAKE_PROJECT_ID,
  createHoldingProjectWorkers,
  fakeHostDeps,
  readDiscoveryFile,
  waitFor,
} from "./worker-host-fakes";

setDefaultTimeout(20_000);

const INSTANCE = "test-worker-start";

let home: string;
let databasePath: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "scarn-worker-start-"));
  databasePath = path.join(home, "db.sqlite");
  setHomeDirForTests(home);
});

afterEach(() => {
  setHomeDirForTests(undefined);
  rmSync(home, { recursive: true, force: true });
});

function hostDeps(
  lines: string[],
  overrides: Partial<ForegroundWorkerDeps> = {},
): ForegroundWorkerDeps & { stopSignal: () => void } {
  let onSignal: ((signal: string) => void) | undefined;
  return {
    openStore: () => new SqliteWorkerSettingsStore({ databasePath }),
    openSessions: () => new SqliteLocalRuntimeSessionStore(databasePath),
    createHostDeps: () => fakeHostDeps,
    createProjectWorker: createHoldingProjectWorkers((line) =>
      lines.push(line),
    ),
    subscribeStopSignals: (listener) => {
      onSignal = listener;
      return () => {
        onSignal = undefined;
      };
    },
    print: (line) => lines.push(line),
    env: {},
    ...overrides,
    stopSignal: () => {
      onSignal?.("SIGTERM");
    },
  };
}

function savedInstance() {
  const store = new SqliteWorkerSettingsStore({ databasePath });
  try {
    return store.getInstance(INSTANCE);
  } finally {
    store.close();
  }
}

/** A real control server for a second "running" worker of the instance. */
function startRivalWorker(): { server: ControlServer; close(): Promise<void> } {
  const store = new SqliteWorkerSettingsStore({
    databasePath: path.join(home, "rival.sqlite"),
  });
  const logger = createWorkerHostLogger({ instance: INSTANCE });
  const supervisor = new WorkerSupervisor({
    instance: INSTANCE,
    store,
    defaultMaxConcurrency: 1,
    projectWorkerDeps: { hostDeps: fakeHostDeps },
  });
  const server = startControlServer({
    supervisor,
    slots: supervisor.slots,
    version: "test",
    pid: process.pid,
    startedAt: new Date().toISOString(),
    logFilePath: path.join(home, "rival.log"),
  });
  writeWorkerDiscovery({
    pid: process.pid,
    port: server.port,
    token: server.token,
    version: "test",
    protocol: 1,
    instance: INSTANCE,
    baseUrl: null,
    startedAt: new Date().toISOString(),
  });
  return {
    server,
    close: async () => {
      await server.close({ force: true });
      logger.close();
      store.close();
    },
  };
}

describe("worker start --foreground", () => {
  test("refuses to start a second worker for the same instance", async () => {
    const rival = startRivalWorker();
    try {
      const lines: string[] = [];
      const error = await rejection(
        runForegroundWorker({ instance: INSTANCE }, hostDeps(lines)),
      );

      expect(error).toBeInstanceOf(WorkerAlreadyRunningError);
      expect(readDiscoveryFile(INSTANCE)?.port).toBe(rival.server.port);
      expect(savedInstance()).toBeNull();
    } finally {
      await rival.close();
    }
  });

  test("refuses while a live process holds the instance lock", async () => {
    const lock = acquireInstanceLock(INSTANCE, { pid: process.pid });
    try {
      const error = await rejection(
        runForegroundWorker({ instance: INSTANCE }, hostDeps([])),
      );

      expect(error).toBeInstanceOf(WorkerAlreadyRunningError);
    } finally {
      if ("release" in lock) lock.release();
    }
  });

  test("replaces a stale worker.json, binds the base URL and cleans up on stop", async () => {
    writeWorkerDiscovery({
      pid: 999_999,
      port: 1,
      token: "stale",
      version: "old",
      protocol: 1,
      instance: INSTANCE,
      baseUrl: null,
      startedAt: new Date(0).toISOString(),
    });
    const lines: string[] = [];
    const deps = hostDeps(lines);

    const running = runForegroundWorker(
      { instance: INSTANCE, baseUrl: "http://scarn.test/", maxConcurrency: 3 },
      deps,
    );
    await waitFor(() => readDiscoveryFile(INSTANCE)?.pid === process.pid);
    const discovery = readDiscoveryFile(INSTANCE);
    expect(discovery).toMatchObject({
      instance: INSTANCE,
      baseUrl: "http://scarn.test",
    });
    expect(discovery?.token).not.toBe("stale");
    const health = await fetch(
      `http://127.0.0.1:${String(discovery?.port)}/health`,
      {
        headers: { authorization: `Bearer ${String(discovery?.token)}` },
      },
    );
    expect(health.status).toBe(200);

    deps.stopSignal();
    await running;

    expect(existsSync(workerDiscoveryFilePath(INSTANCE))).toBe(false);
    expect(savedInstance()).toMatchObject({
      baseUrl: "http://scarn.test",
      maxConcurrency: 3,
    });
  });

  test("keeps the saved settings on a later start and refuses another base URL", async () => {
    const first = hostDeps([]);
    const running = runForegroundWorker(
      { instance: INSTANCE, baseUrl: "http://scarn.test", maxConcurrency: 2 },
      first,
    );
    await waitFor(() => readDiscoveryFile(INSTANCE) !== null);
    first.stopSignal();
    await running;

    const error = await rejection(
      runForegroundWorker(
        { instance: INSTANCE, baseUrl: "http://other.test" },
        hostDeps([]),
      ),
    );
    expect(String(error)).toContain("SCARN_WORKER_INSTANCE");
    expect(existsSync(workerDiscoveryFilePath(INSTANCE))).toBe(false);

    const second = hostDeps([]);
    const again = runForegroundWorker({ instance: INSTANCE }, second);
    await waitFor(() => readDiscoveryFile(INSTANCE) !== null);
    expect(readDiscoveryFile(INSTANCE)?.baseUrl).toBe("http://scarn.test");
    second.stopSignal();
    await again;
    expect(savedInstance()?.maxConcurrency).toBe(2);
  });

  test.skipIf(process.platform === "win32")(
    "the first signal drains, the second forces (child process)",
    async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          path.join(cliProjectRoot, "test/fixtures/foreground-worker.ts"),
        ],
        {
          cwd: cliProjectRoot,
          env: {
            ...process.env,
            HOME: home,
            SCARN_LOCAL_DB_PATH: databasePath,
            SCARN_WORKER_INSTANCE: INSTANCE,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const lines: string[] = [];
      void (async () => {
        const decoder = new TextDecoder();
        let buffered = "";
        const reader = child.stdout.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value);
          const parts = buffered.split("\n");
          buffered = parts.pop() ?? "";
          lines.push(...parts);
        }
      })();
      const stderr = new Response(child.stderr).text();
      const discoveryPath = path.join(
        home,
        ".scarn",
        "workers",
        INSTANCE,
        "worker.json",
      );

      try {
        await waitFor(() => lines.includes("run started"));
        expect(existsSync(discoveryPath)).toBe(true);

        child.kill("SIGTERM");
        await waitFor(() => lines.includes("project draining"));
        await Bun.sleep(200);
        expect(child.exitCode).toBeNull();
        expect(lines).not.toContain("run ended: worker_stopped");
        expect(existsSync(discoveryPath)).toBe(true);

        child.kill("SIGINT");
        expect(await child.exited).toBe(0);
        expect(lines).toContain("run ended: worker_stopped");
        expect(lines).toContain("exited cleanly");
        expect(existsSync(discoveryPath)).toBe(false);
      } catch (error) {
        child.kill("SIGKILL");
        throw new Error(
          `${String(error)}\nstdout:\n${lines.join("\n")}\nstderr:\n${await stderr}`,
        );
      }
    },
  );
});

describe("worker start --foreground --once", () => {
  test("runs one pass with local slots and saves nothing", async () => {
    const calls: Array<
      ProcessProjectWorkOptions & { env: Record<string, string> | undefined }
    > = [];
    const result = await runWorkerOnce(
      {
        instance: INSTANCE,
        project: "acme/app",
        concurrency: 2,
        preserveRuntimeOnComplete: true,
        workItemId: "item-1",
      },
      {
        reporter: noopReporter,
        logger: createCliLogger("worker-start-test"),
        resolveTarget: () =>
          Promise.resolve({
            baseUrl: "http://scarn.test",
            projectRef: "acme/app",
            projectId: FAKE_PROJECT_ID,
            repoDir: home,
            sourceBranch: "main",
            sourceBranchWarning: undefined,
          }),
        readLocalEnv: () => Promise.resolve({ TOKEN: "x" }),
        runProjectWork: async (options) => {
          calls.push({ ...options, env: await options.readLocalEnv?.() });
          return { claimedCount: 0, processedCount: 0, skippedCount: 0 };
        },
      },
    );

    expect(result.claimedCount).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      projectId: FAKE_PROJECT_ID,
      baseUrl: "http://scarn.test",
      once: true,
      concurrency: 2,
      preserveRuntimeOnComplete: true,
      workItemId: "item-1",
      sourceBranch: "main",
      env: { TOKEN: "x" },
    });
    expect(calls[0]?.slots).toBeUndefined();
    expect(existsSync(workerDiscoveryFilePath(INSTANCE))).toBe(false);
    expect(existsSync(databasePath)).toBe(false);
  });

  test("the CLI exits 0 and leaves no worker.json or saved settings", async () => {
    const result = Bun.spawn(
      [
        process.execPath,
        "run",
        path.join(cliProjectRoot, "test/fixtures/worker-once.ts"),
      ],
      {
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
          SCARN_LOCAL_DB_PATH: databasePath,
          SCARN_WORKER_INSTANCE: INSTANCE,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(result.stdout).text(),
      new Response(result.stderr).text(),
      result.exited,
    ]);
    expect({ exitCode, stderr, stdout }).toMatchObject({ exitCode: 0 });
    expect(stdout).toContain('"once":true');
    expect(stdout).toContain('"preserveRuntimeOnComplete":true');
    expect(stdout).toContain('"workItemId":"item-1"');
    expect(
      existsSync(path.join(home, ".scarn", "workers", INSTANCE, "worker.json")),
    ).toBe(false);
    if (existsSync(databasePath)) {
      const db = new Database(databasePath, { readonly: true });
      try {
        const tables = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'worker_%'",
          )
          .all()
          .map((row) => row.name);
        for (const table of tables) {
          expect(
            db
              .query<{ count: number }, []>(
                `SELECT COUNT(*) AS count FROM ${table}`,
              )
              .get()?.count,
          ).toBe(0);
        }
      } finally {
        db.close();
      }
    }
  });
});
