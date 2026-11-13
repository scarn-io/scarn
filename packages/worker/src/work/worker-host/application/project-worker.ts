import { stat } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { readLocalEnvVars } from "../../../project/local-env/read-local-env-vars";
import { processProjectWork } from "../../task-run/application/process-project-work";
import {
  buildProjectWorkSetup,
  type ProjectWorkHostDeps,
  type ProjectWorkOptions,
  type ProjectWorkSetup,
} from "../../task-run/application/project-work-setup";
import type { RunRegistry } from "../../task-run/application/run-registry";
import type { SlotPort } from "../contracts/slot-port";
import type { WorkerProjectSettings } from "../contracts/worker-settings";
import {
  classifyProjectWorkerError,
  isAuthErrorReason,
  MAX_RETRY_DELAY_MS,
  RepoMissingError,
  retryDelayMs,
  type ProjectWorkerErrorReason,
  type ProjectWorkerStateName,
} from "../domain/project-worker-state";
import {
  watchAuthFile as defaultWatchAuthFile,
  type AuthFileWatcher,
} from "../infra/auth-file-watcher";

/** The server's cap on one claim; the slot allocator decides the real count. */
const MAX_CLAIM_BATCH = 100;

/** The settings whose change needs a fresh loop rather than an in-place update. */
const RESTART_KEYS = [
  "repoDir",
  "sourceBranch",
  "preserveRuntime",
  "baseUrl",
  "addedByUserId",
] as const satisfies readonly (keyof WorkerProjectSettings)[];

/** Schedules `callback`; the returned function cancels it. */
export type ProjectWorkerTimer = (
  callback: () => void,
  milliseconds: number,
) => () => void;

export type ProjectWorkerStatus = {
  projectId: string;
  projectRef: string;
  state: ProjectWorkerStateName;
  errorReason: ProjectWorkerErrorReason | null;
  errorMessage: string | null;
  nextRetryAt: string | null;
  settings: WorkerProjectSettings;
  activeRuns: number;
};

export type ProjectWorkerDeps = {
  hostDeps: ProjectWorkHostDeps;
  /** Shared with every other project worker; this worker sets its own limit. */
  slots: SlotPort & {
    setProjectLimit(projectId: string, limit: number | null): void;
  };
  runRegistry: RunRegistry;
  hostname?: (() => string) | undefined;
  repoExists?: ((repoDir: string) => Promise<boolean>) | undefined;
  watchAuthFile?: AuthFileWatcher | undefined;
  schedule?: ProjectWorkerTimer | undefined;
  now?: (() => Date) | undefined;
  /** Loop tuning passed through to the setup (poll intervals, lease, ...). */
  loopOptions?:
    | Pick<
        ProjectWorkOptions,
        | "pollIntervalMs"
        | "maxPollIntervalMs"
        | "connectedMaxPollIntervalMs"
        | "leaseDurationSeconds"
        | "sessionStartTimeoutMs"
        | "missingFindingsGraceMs"
        | "reporter"
      >
    | undefined;
  onStateChange?: ((status: ProjectWorkerStatus) => void) | undefined;
};

export type ProjectWorkerUpdate = "applied" | "restart_required";

type ErrorState = {
  reason: ProjectWorkerErrorReason;
  message: string;
  nextRetryAt: Date;
};

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

const realTimer: ProjectWorkerTimer = (callback, milliseconds) => {
  const handle = setTimeout(callback, milliseconds);
  return () => {
    clearTimeout(handle);
  };
};

/** Whether moving from `current` to `next` needs a fresh project worker. */
export function needsProjectWorkerRestart(
  current: WorkerProjectSettings,
  next: WorkerProjectSettings,
): boolean {
  return RESTART_KEYS.some((key) => next[key] !== current[key]);
}

export function projectWorkerId(
  host: string,
  instance: string,
  projectId: string,
): string {
  return `scarn-worker-${host}-${instance}-${projectId}`;
}

/**
 * One project's loop inside the background worker. It builds the loop from
 * the shared setup (shared slot allocator and run registry, its own drain
 * signal, `.scarn/.env` from the saved repo directory, the saved source
 * branch, a stable worker id) and keeps it going:
 *
 * - When the loop cannot start or stops with an error, the worker enters
 *   `error` with a {@link ProjectWorkerErrorReason}. It claims nothing new,
 *   but runs already claimed keep going. It retries after 30s, doubling up to
 *   5 minutes; for login problems it also retries as soon as `auth.jsonc`
 *   changes. Other project workers are never affected.
 * - The concurrency limit and work-item filter change in place
 *   ({@link updateSettings}); the filter applies from the next claim.
 * - {@link drain} stops claiming and settles once every run has finished.
 */
export class ProjectWorker {
  #settings: WorkerProjectSettings;
  readonly #deps: ProjectWorkerDeps;
  readonly #schedule: ProjectWorkerTimer;
  readonly #now: () => Date;
  readonly #loops = new Set<Promise<void>>();
  #state: ProjectWorkerStateName = "stopped";
  #error: ErrorState | null = null;
  #generation = 0;
  #attempt = 0;
  #runningSince: Date | null = null;
  #drainController: AbortController | null = null;
  #cancelRetry: (() => void) | null = null;
  #stopWatchingAuth: (() => void) | null = null;

  constructor(settings: WorkerProjectSettings, deps: ProjectWorkerDeps) {
    this.#settings = settings;
    this.#deps = deps;
    this.#schedule = deps.schedule ?? realTimer;
    this.#now = deps.now ?? (() => new Date());
  }

  get state(): ProjectWorkerStateName {
    return this.#state;
  }

  get projectId(): string {
    return this.#settings.projectId;
  }

  get settings(): WorkerProjectSettings {
    return this.#settings;
  }

  get workerId(): string {
    return projectWorkerId(
      (this.#deps.hostname ?? osHostname)(),
      this.#settings.instance,
      this.#settings.projectId,
    );
  }

  /** Starts the loop. Does nothing unless the worker is stopped. */
  start(): Promise<void> {
    if (this.#state !== "stopped") return Promise.resolve();
    this.#deps.slots.setProjectLimit(
      this.projectId,
      this.#settings.concurrency,
    );
    return this.#launch();
  }

  /**
   * Applies new saved settings. The limit and work-item filter change in
   * place; a different repo directory, branch, runtime-preservation setting,
   * base URL or user needs a fresh loop, which the caller does by draining
   * this worker and starting another.
   */
  updateSettings(next: WorkerProjectSettings): ProjectWorkerUpdate {
    if (next.projectId !== this.projectId) {
      throw new Error(
        `Cannot update project ${this.projectId} with settings for ${next.projectId}.`,
      );
    }
    if (needsProjectWorkerRestart(this.#settings, next)) {
      return "restart_required";
    }
    const limitChanged = next.concurrency !== this.#settings.concurrency;
    this.#settings = next;
    if (limitChanged) {
      this.#deps.slots.setProjectLimit(this.projectId, next.concurrency);
    }
    this.#notify();
    return "applied";
  }

  /** Retries at once when in `error`; otherwise does nothing. */
  retryNow(): Promise<void> {
    if (this.#state !== "error") return Promise.resolve();
    this.#clearRetry();
    return this.#launch();
  }

  /**
   * Stops claiming, cancels any pending retry, and settles once every loop
   * this worker started has returned, i.e. once its runs have finished.
   */
  async drain(): Promise<void> {
    this.#generation += 1;
    this.#clearRetry();
    this.#drainController?.abort();
    this.#drainController = null;
    if (this.#state !== "stopped") this.#setState("draining");
    while (this.#loops.size > 0) {
      await Promise.allSettled([...this.#loops]);
    }
    this.#error = null;
    this.#runningSince = null;
    this.#setState("stopped");
  }

  status(): ProjectWorkerStatus {
    return {
      projectId: this.projectId,
      projectRef: this.#settings.projectRef,
      state: this.#state,
      errorReason: this.#error?.reason ?? null,
      errorMessage: this.#error?.message ?? null,
      nextRetryAt: this.#error?.nextRetryAt.toISOString() ?? null,
      settings: this.#settings,
      activeRuns: this.#deps.runRegistry.count({ projectId: this.projectId }),
    };
  }

  #launch(): Promise<void> {
    this.#generation += 1;
    const generation = this.#generation;
    this.#error = null;
    this.#setState("starting");
    const launch = this.#startLoop(generation).catch(
      // eslint-disable-next-line local/no-unknown-parameter-type -- a rejection is untyped
      (error: unknown) => {
        this.#fail(generation, error);
      },
    );
    this.#track(launch);
    return launch;
  }

  async #startLoop(generation: number): Promise<void> {
    const { repoDir } = this.#settings;
    if (!(await (this.#deps.repoExists ?? directoryExists)(repoDir))) {
      throw new RepoMissingError(repoDir);
    }
    if (generation !== this.#generation) return;

    const drainController = new AbortController();
    const setup = await buildProjectWorkSetup(
      this.#loopOptions(drainController.signal, (error) => {
        setup.close();
        this.#fail(generation, error);
      }),
      this.#deps.hostDeps,
    );
    if (generation !== this.#generation) {
      setup.close();
      return;
    }

    this.#drainController = drainController;
    this.#runningSince = this.#now();
    this.#setState("running");
    this.#track(this.#runLoop(setup, generation));
  }

  async #runLoop(setup: ProjectWorkSetup, generation: number): Promise<void> {
    try {
      await processProjectWork(setup.input, setup.deps);
    } catch (error: unknown) {
      this.#fail(generation, error);
    } finally {
      setup.close();
    }
  }

  #loopOptions(
    drainSignal: AbortSignal,
    onLoopError: NonNullable<ProjectWorkOptions["onLoopError"]>,
  ): ProjectWorkOptions {
    const settings = this.#settings;
    return {
      ...this.#deps.loopOptions,
      projectId: settings.projectId,
      baseUrl: settings.baseUrl,
      expectedUserId: settings.addedByUserId,
      workerId: this.workerId,
      batchSize: MAX_CLAIM_BATCH,
      concurrency: settings.concurrency ?? 1,
      readWorkItemId: () => this.#settings.workItemId ?? undefined,
      preserveRuntimeOnComplete: settings.preserveRuntime,
      sourceBranch: settings.sourceBranch,
      readLocalEnv: () => readLocalEnvVars(settings.repoDir),
      slots: this.#deps.slots,
      runRegistry: this.#deps.runRegistry,
      drainSignal,
      onLoopError,
      once: false,
    };
  }

  // eslint-disable-next-line local/no-unknown-parameter-type -- errors from a loop are untyped
  #fail(generation: number, error: unknown): void {
    if (generation !== this.#generation) return;
    this.#generation += 1;
    this.#drainController = null;

    const now = this.#now();
    if (
      this.#runningSince &&
      now.getTime() - this.#runningSince.getTime() >= MAX_RETRY_DELAY_MS
    ) {
      this.#attempt = 0;
    }
    this.#runningSince = null;

    const reason = classifyProjectWorkerError(error);
    const delay = retryDelayMs(this.#attempt);
    this.#attempt += 1;
    this.#error = {
      reason,
      message: error instanceof Error ? error.message : String(error),
      nextRetryAt: new Date(now.getTime() + delay),
    };
    this.#deps.hostDeps.logger.error("worker", "Project worker stopped", {
      projectId: this.projectId,
      reason,
      error,
      retryInMs: delay,
    });

    this.#cancelRetry = this.#schedule(() => {
      this.#cancelRetry = null;
      void this.retryNow();
    }, delay);
    if (isAuthErrorReason(reason)) {
      this.#stopWatchingAuth = (
        this.#deps.watchAuthFile ?? defaultWatchAuthFile
      )(() => {
        void this.retryNow();
      });
    }
    this.#setState("error");
  }

  #clearRetry(): void {
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    this.#stopWatchingAuth?.();
    this.#stopWatchingAuth = null;
  }

  #track(loop: Promise<void>): void {
    this.#loops.add(loop);
    void loop.finally(() => this.#loops.delete(loop));
  }

  #setState(state: ProjectWorkerStateName): void {
    this.#state = state;
    if (state === "running") this.#error = null;
    this.#notify();
  }

  #notify(): void {
    this.#deps.onStateChange?.(this.status());
  }
}
