/**
 * `scarn worker start --foreground`: hosts the instance's background worker
 * in this process until it is told to stop.
 *
 * It refuses to start while another worker for the instance is alive (a
 * `worker.json` that answers, or the instance lock held by a live process);
 * a stale `worker.json` or lock is replaced. It then binds the instance's
 * base URL, starts the supervisor behind the control server, writes
 * `worker.json`, and restores the saved projects. The first stop signal (or
 * `POST /stop`) drains, a second one forces; once every run has ended it
 * closes the control server and removes `worker.json` and the lock.
 */
import {
  CONTROL_API_PROTOCOL,
  SqliteLocalRuntimeSessionStore,
  SqliteWorkerSettingsStore,
  WorkerSupervisor,
  WorkerUnresponsiveError,
  createDefaultProjectWorkDeps,
  createWorkerHostLogger,
  findRunningWorker,
  removeWorkerDiscovery,
  startControlServer,
  workerLogFilePath,
  writeWorkerDiscovery,
  type CreateProjectWorker,
  type ProjectWorkerDeps,
  type RecentRunsSource,
  type RunningWorker,
  type WorkerHostLogger,
  type WorkerSettingsStore,
} from "@scarn/worker";
import type { DestinationStream } from "pino";
import { resolveWorkerVersion } from "../../lib/worker-version";
import {
  acquireInstanceLock,
  isInstanceLock,
  type InstanceLock,
} from "./instance-lock";
import { bindInstanceSettings } from "./instance-settings";
import {
  subscribeProcessStopSignals,
  type SubscribeStopSignals,
} from "./stop-signals";
import { WorkerAlreadyRunningError } from "./worker-errors";

export type ForegroundWorkerOptions = {
  instance: string;
  baseUrl?: string | undefined;
  maxConcurrency?: number | undefined;
};

export type ForegroundWorkerDeps = {
  pid?: number | undefined;
  version?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  openStore?: (() => WorkerSettingsStore) | undefined;
  openSessions?: (() => RecentRunsSource & { close(): void }) | undefined;
  createLogger?: ((instance: string) => WorkerHostLogger) | undefined;
  createHostDeps?:
    ((dest: DestinationStream) => ProjectWorkerDeps["hostDeps"]) | undefined;
  createProjectWorker?: CreateProjectWorker | undefined;
  subscribeStopSignals?: SubscribeStopSignals | undefined;
  findRunningWorker?:
    ((instance: string) => Promise<RunningWorker | null>) | undefined;
  /** Human-facing progress; stdout by default. */
  print?: ((line: string) => void) | undefined;
};

type Resources = {
  lock?: InstanceLock;
  store?: WorkerSettingsStore;
  sessions?: RecentRunsSource & { close(): void };
  hostLogger?: WorkerHostLogger;
  server?: { close(options?: { force?: boolean }): Promise<void> };
  wroteDiscovery?: boolean;
  unsubscribe?: () => void;
};

/** Runs the worker until it has stopped; throws when it may not start. */
export async function runForegroundWorker(
  options: ForegroundWorkerOptions,
  deps: ForegroundWorkerDeps = {},
): Promise<void> {
  const { instance } = options;
  const pid = deps.pid ?? process.pid;
  const print =
    deps.print ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  await assertNoRunningWorker(instance, deps.findRunningWorker);
  const held: Resources = {};
  try {
    const lock = acquireInstanceLock(instance, { pid });
    if (!isInstanceLock(lock)) {
      throw new WorkerAlreadyRunningError(instance, lock.heldBy);
    }
    held.lock = lock;
    held.store = (deps.openStore ?? (() => new SqliteWorkerSettingsStore()))();
    const settings = bindInstanceSettings(held.store, {
      instance,
      baseUrl: options.baseUrl,
      maxConcurrency: options.maxConcurrency,
      env: deps.env,
    });
    held.sessions = (
      deps.openSessions ?? (() => new SqliteLocalRuntimeSessionStore())
    )();
    held.hostLogger = (
      deps.createLogger ??
      ((name: string) => createWorkerHostLogger({ instance: name }))
    )(instance);
    const logger = held.hostLogger.logger;
    const createHostDeps =
      deps.createHostDeps ??
      ((dest: DestinationStream) => createDefaultProjectWorkDeps(dest));
    const supervisor = new WorkerSupervisor({
      instance,
      store: held.store,
      defaultMaxConcurrency: settings.maxConcurrency,
      projectWorkerDeps: {
        hostDeps: createHostDeps(held.hostLogger.destination),
      },
      sessions: held.sessions,
      createProjectWorker: deps.createProjectWorker,
    });

    let stopRequests = 0;
    let resolveStopped!: (done: Promise<void>) => void;
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    const requestStop = (force: boolean, done?: Promise<void>) => {
      stopRequests += 1;
      const forced = force || stopRequests > 1;
      print(
        forced
          ? "Forcing the worker to stop: aborting every run."
          : "Draining: no new work is claimed; runs already going finish. Signal again to force.",
      );
      logger.info({ force: forced }, "Worker stop requested");
      resolveStopped(done ?? supervisor.stop({ force: forced }));
    };

    const version = deps.version ?? resolveWorkerVersion();
    const startedAt = new Date().toISOString();
    const logFilePath = workerLogFilePath(instance);
    const server = startControlServer({
      supervisor,
      slots: supervisor.slots,
      version,
      pid,
      startedAt,
      logFilePath,
      onStopRequested: ({ force, done }) => {
        requestStop(force, done);
      },
    });
    held.server = server;
    held.unsubscribe = (
      deps.subscribeStopSignals ?? subscribeProcessStopSignals
    )(() => {
      requestStop(false);
    });
    writeWorkerDiscovery({
      pid,
      port: server.port,
      token: server.token,
      version,
      protocol: CONTROL_API_PROTOCOL,
      instance,
      baseUrl: settings.baseUrl,
      startedAt,
    });
    held.wroteDiscovery = true;
    logger.info(
      {
        instance,
        pid,
        port: server.port,
        version,
        baseUrl: settings.baseUrl,
        maxConcurrency: settings.maxConcurrency,
      },
      "Worker started",
    );
    print(
      `Worker instance ${instance} is running (pid ${String(pid)}, port ${String(server.port)}).`,
    );
    print(`Logs: ${logFilePath}`);

    await supervisor.start();
    await stopped;
    logger.info({ instance }, "Worker stopped");
    print(`Worker instance ${instance} stopped.`);
  } finally {
    await release(held, instance, pid);
  }
}

async function assertNoRunningWorker(
  instance: string,
  find: ForegroundWorkerDeps["findRunningWorker"],
): Promise<void> {
  try {
    const running = await (find ?? findRunningWorker)(instance);
    if (running) {
      throw new WorkerAlreadyRunningError(instance, running.discovery.pid);
    }
  } catch (error) {
    if (error instanceof WorkerUnresponsiveError) {
      throw new WorkerAlreadyRunningError(instance, error.pid);
    }
    throw error;
  }
}

async function release(
  held: Resources,
  instance: string,
  pid: number,
): Promise<void> {
  held.unsubscribe?.();
  await held.server?.close({ force: true }).catch(() => undefined);
  if (held.wroteDiscovery) removeWorkerDiscovery(instance, { onlyIfPid: pid });
  held.lock?.release();
  held.hostLogger?.close();
  held.sessions?.close();
  held.store?.close();
}
