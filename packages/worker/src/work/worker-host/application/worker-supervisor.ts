import {
  RunRegistry,
  type RunPhase,
} from "../../task-run/application/run-registry";
import type { LocalRuntimeSessionRecord } from "../../task-run/infra/sqlite-local-runtime-session-store";
import type {
  UpsertWorkerProjectInput,
  WorkerProjectSettings,
  WorkerSettingsStore,
} from "../contracts/worker-settings";
import type { SlotPort } from "../contracts/slot-port";
import { SlotAllocator, type SlotSnapshot } from "../domain/slot-allocator";
import {
  WorkerBaseUrlMismatchError,
  WorkerNotRunningError,
} from "../domain/worker-supervisor-errors";
import {
  needsProjectWorkerRestart,
  ProjectWorker,
  type ProjectWorkerDeps,
  type ProjectWorkerStatus,
} from "./project-worker";

/**
 * Where the background worker is in its life:
 * - `starting`: restoring its saved projects.
 * - `running`: its project workers are claiming work.
 * - `draining`: stopping; no project worker claims anything new, and runs
 *   already going finish normally.
 * - `stopping`: a forced stop; every run has been aborted with `worker_stopped`.
 * - `stopped`: not started yet, or every project worker has stopped.
 */
export type WorkerSupervisorState =
  "starting" | "running" | "draining" | "stopping" | "stopped";

/** The project worker operations the supervisor uses. */
export type SupervisedProjectWorker = Pick<
  ProjectWorker,
  "projectId" | "settings" | "start" | "updateSettings" | "drain" | "status"
>;

export type CreateProjectWorker = (
  settings: WorkerProjectSettings,
  deps: ProjectWorkerDeps,
) => SupervisedProjectWorker;

/** Where recent finished runs come from; the sqlite session store fits. */
export type RecentRunsSource = {
  listRecent(
    limit: number,
    projectIds: readonly string[],
  ): LocalRuntimeSessionRecord[];
};

export type WorkerSupervisorOptions = {
  instance: string;
  store: WorkerSettingsStore;
  /** The machine-wide limit used until one is saved for the instance. */
  defaultMaxConcurrency: number;
  /** Shared by every project worker; the supervisor adds slots and registry. */
  projectWorkerDeps: Omit<ProjectWorkerDeps, "slots" | "runRegistry">;
  sessions?: RecentRunsSource | undefined;
  runRegistry?: RunRegistry | undefined;
  createProjectWorker?: CreateProjectWorker | undefined;
};

/** A project's settings as given to {@link WorkerSupervisor.addOrUpdateProject}. */
export type ProjectSettingsInput = Omit<UpsertWorkerProjectInput, "instance">;

/**
 * - `added`: a new project worker started (it may be in error).
 * - `updated`: the limit or work-item filter changed in place.
 * - `restarting`: the old project worker is draining; a new one starts once
 *   it has drained.
 * - `removed`: a later {@link WorkerSupervisor.removeProject} won the race.
 */
export type AddOrUpdateProjectOutcome =
  "added" | "updated" | "restarting" | "removed";

export type AddOrUpdateProjectResult = {
  outcome: AddOrUpdateProjectOutcome;
  project: ProjectWorkerStatus | null;
};

/** One run in flight on this worker, without its abort handle. */
export type ActiveRunStatus = {
  taskRunId: string;
  projectId: string;
  taskName: string | null;
  phase: RunPhase;
  startedAt: string;
};

export type RemoveProjectResult = {
  removed: boolean;
  /** Runs of the project still going; they finish normally. */
  drainingRuns: ActiveRunStatus[];
};

export type WorkerSupervisorStatus = {
  instance: string;
  baseUrl: string | null;
  state: WorkerSupervisorState;
  maxConcurrency: number;
  slots: SlotSnapshot;
  projects: ProjectWorkerStatus[];
  activeRuns: ActiveRunStatus[];
  recentRuns: LocalRuntimeSessionRecord[];
};

const defaultCreateProjectWorker: CreateProjectWorker = (settings, deps) =>
  new ProjectWorker(settings, deps);

type PassOutcome = Exclude<AddOrUpdateProjectOutcome, "removed"> | null;

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * The background worker for one instance on this machine. It owns the slot
 * allocator, the run registry, and one project worker for each saved
 * project:
 *
 * - {@link start} restores the saved machine limit and every saved project.
 *   A project that fails to restore keeps its settings and shows as an
 *   error; other projects are never affected.
 * - {@link addOrUpdateProject} saves a project and starts its project
 *   worker, or changes its limit and work-item filter in place. A different
 *   repo directory, branch or runtime setting drains the old project worker
 *   and then starts a new one.
 * - {@link removeProject} deletes a project's settings and drains its
 *   project worker; its runs finish normally.
 * - {@link stop} drains every project worker and keeps saved settings;
 *   `force` also aborts every run, and upgrades a drain already under way.
 *
 * Saved settings are the desired state. Each project has one chain of
 * operations that brings its project worker in line with them, so
 * overlapping calls for one project never leave two project workers.
 */
export class WorkerSupervisor {
  readonly #instance: string;
  readonly #store: WorkerSettingsStore;
  readonly #sessions: RecentRunsSource | undefined;
  readonly #projectWorkerDeps: WorkerSupervisorOptions["projectWorkerDeps"];
  readonly #createProjectWorker: CreateProjectWorker;
  readonly #slots: SlotAllocator;
  readonly #runRegistry: RunRegistry;
  readonly #workers = new Map<string, SupervisedProjectWorker>();
  readonly #retiring = new Map<SupervisedProjectWorker, Promise<void>>();
  readonly #chains = new Map<string, Promise<void>>();
  #maxConcurrency: number;
  #state: WorkerSupervisorState = "stopped";
  #started = false;
  #stopping: Promise<void> | null = null;

  constructor(options: WorkerSupervisorOptions) {
    this.#instance = options.instance;
    this.#store = options.store;
    this.#sessions = options.sessions;
    this.#projectWorkerDeps = options.projectWorkerDeps;
    this.#createProjectWorker =
      options.createProjectWorker ?? defaultCreateProjectWorker;
    this.#maxConcurrency = options.defaultMaxConcurrency;
    this.#slots = new SlotAllocator({ machineLimit: this.#maxConcurrency });
    this.#runRegistry = options.runRegistry ?? new RunRegistry();
  }

  get state(): WorkerSupervisorState {
    return this.#state;
  }

  get instance(): string {
    return this.#instance;
  }

  /** The machine's slot allocator, shared with borrowers through slot leases. */
  get slots(): SlotPort {
    return this.#slots;
  }

  /**
   * Restores the saved machine limit and every saved project, and resolves
   * once each project worker is running or in error. Only once.
   */
  async start(): Promise<void> {
    if (this.#started) {
      throw new Error(`Worker instance ${this.#instance} was already started.`);
    }
    this.#started = true;
    this.#state = "starting";
    const saved = this.#store.getInstance(this.#instance);
    if (saved) this.#applyMachineLimit(saved.maxConcurrency);
    await Promise.all(
      this.#store
        .listProjects(this.#instance)
        .map((settings) => this.#reconcile(settings.projectId).acknowledged),
    );
    if (!this.#stopping) this.#state = "running";
  }

  /**
   * Saves a project's settings and brings its project worker in line with
   * them. Resolves once the project worker is running or in error, the
   * change is applied in place, or (`restarting`) the old project worker is
   * draining; the new one starts once it has drained.
   *
   * Throws {@link WorkerNotRunningError} before start or once stopping, and
   * {@link WorkerBaseUrlMismatchError} for a project from another server.
   */
  async addOrUpdateProject(
    input: ProjectSettingsInput,
  ): Promise<AddOrUpdateProjectResult> {
    this.#assertAccepting();
    if (input.concurrency !== null) {
      assertNonNegativeInt(input.concurrency, "concurrency");
    }
    this.#bindBaseUrl(input.baseUrl);
    this.#store.upsertProject({ ...input, instance: this.#instance });

    const pass = this.#reconcile(input.projectId);
    const outcome = this.#isDraining(input.projectId)
      ? "restarting"
      : await pass.acknowledged;
    if (outcome === null && this.#stopping) {
      throw new WorkerNotRunningError(this.#instance);
    }
    return {
      outcome: outcome ?? "removed",
      project: this.#projectStatus(input.projectId),
    };
  }

  /**
   * Deletes a project's settings and drains its project worker in the
   * background. Returns at once with the project's runs still going; they
   * finish normally.
   */
  removeProject(projectId: string): RemoveProjectResult {
    const deleted = this.#store.deleteProject(this.#instance, projectId);
    const known = deleted || this.#workers.has(projectId);
    if (known) void this.#reconcile(projectId).done;
    return { removed: known, drainingRuns: this.#activeRuns(projectId) };
  }

  /**
   * Changes the machine-wide limit, and saves it once the instance has
   * saved settings. Runs already going finish.
   */
  setMachineLimit(limit: number): { maxConcurrency: number } {
    this.#applyMachineLimit(limit);
    const saved = this.#store.getInstance(this.#instance);
    if (saved) {
      this.#store.saveInstance({
        instance: this.#instance,
        baseUrl: saved.baseUrl,
        maxConcurrency: limit,
      });
    }
    return { maxConcurrency: limit };
  }

  /**
   * Aborts a run on this worker quietly, as if its claim were revoked.
   * `found` is false when no run with that id is going on this worker.
   */
  cancelRun(taskRunId: string): { found: boolean } {
    return { found: this.#runRegistry.abort(taskRunId, "cancelled") };
  }

  /**
   * Drains every project worker and resolves once each has stopped and
   * every run has ended. Saved settings are kept. With `force`, every run is
   * aborted with `worker_stopped`; a forced call while a drain is under way
   * upgrades that drain.
   */
  stop(options: { force?: boolean } = {}): Promise<void> {
    const force = options.force ?? false;
    if (force) this.#runRegistry.abortAll("worker_stopped");
    if (this.#stopping) {
      if (force && this.#state === "draining") this.#state = "stopping";
      return this.#stopping;
    }
    this.#state = force ? "stopping" : "draining";
    this.#stopping = this.#drainAll();
    return this.#stopping;
  }

  /** The current state; `recentRuns` lists up to that many finished runs. */
  status(options: { recentRuns?: number } = {}): WorkerSupervisorStatus {
    const projects = [...this.#workers.values(), ...this.#retiring.keys()].map(
      (worker) => worker.status(),
    );
    const projectIds = [
      ...new Set([
        ...this.#store
          .listProjects(this.#instance)
          .map((project) => project.projectId),
        ...projects.map((project) => project.projectId),
      ]),
    ];
    return {
      instance: this.#instance,
      baseUrl: this.#store.getInstance(this.#instance)?.baseUrl ?? null,
      state: this.#state,
      maxConcurrency: this.#maxConcurrency,
      slots: this.#slots.snapshot(),
      projects,
      activeRuns: this.#activeRuns(),
      recentRuns:
        this.#sessions?.listRecent(options.recentRuns ?? 0, projectIds) ?? [],
    };
  }

  /**
   * Queues one pass that brings the project's worker in line with its saved
   * settings. `acknowledged` resolves with what the pass did (null when the
   * project is gone or the worker is stopping); `done` once it has finished.
   */
  #reconcile(projectId: string): {
    acknowledged: Promise<PassOutcome>;
    done: Promise<void>;
  } {
    const ack = deferred<PassOutcome>();
    const previous = this.#chains.get(projectId) ?? Promise.resolve();
    const done = previous
      .then(() => this.#reconcileNow(projectId, ack))
      // eslint-disable-next-line local/no-unknown-parameter-type -- a rejection is untyped
      .catch((error: unknown) => {
        this.#projectWorkerDeps.hostDeps.logger.error(
          "worker",
          "Could not bring the project worker in line with its settings",
          { projectId, error },
        );
      });
    this.#chains.set(projectId, done);
    void done.finally(() => {
      ack.resolve(null);
      if (this.#chains.get(projectId) === done) this.#chains.delete(projectId);
    });
    return { acknowledged: ack.promise, done };
  }

  async #reconcileNow(
    projectId: string,
    ack: Deferred<PassOutcome>,
  ): Promise<void> {
    const current = this.#workers.get(projectId);
    const desired = this.#desired(projectId);
    if (
      current &&
      desired &&
      !needsProjectWorkerRestart(current.settings, desired)
    ) {
      current.updateSettings(desired);
      ack.resolve("updated");
      return;
    }
    if (current) {
      const drained = this.#retire(current);
      if (desired) ack.resolve("restarting");
      await drained;
    }
    const latest = this.#desired(projectId);
    if (!latest) return;
    await this.#launch(latest).start();
    ack.resolve(current ? "restarting" : "added");
  }

  #desired(projectId: string): WorkerProjectSettings | null {
    if (this.#stopping) return null;
    return this.#store.getProject(this.#instance, projectId);
  }

  #launch(settings: WorkerProjectSettings): SupervisedProjectWorker {
    const worker = this.#createProjectWorker(settings, {
      ...this.#projectWorkerDeps,
      slots: this.#slots,
      runRegistry: this.#runRegistry,
    });
    this.#workers.set(settings.projectId, worker);
    return worker;
  }

  #retire(worker: SupervisedProjectWorker): Promise<void> {
    const { projectId } = worker;
    if (this.#workers.get(projectId) === worker)
      this.#workers.delete(projectId);
    const existing = this.#retiring.get(worker);
    if (existing) return existing;
    const drained = worker.drain().finally(() => {
      this.#retiring.delete(worker);
      if (!this.#workers.has(projectId)) {
        this.#slots.setProjectLimit(projectId, null);
      }
    });
    this.#retiring.set(worker, drained);
    return drained;
  }

  async #drainAll(): Promise<void> {
    for (const worker of [...this.#workers.values()]) void this.#retire(worker);
    while (this.#chains.size > 0 || this.#retiring.size > 0) {
      await Promise.allSettled([
        ...this.#chains.values(),
        ...this.#retiring.values(),
      ]);
      for (const worker of [...this.#workers.values()]) {
        void this.#retire(worker);
      }
    }
    await Promise.allSettled(this.#runRegistry.jobs());
    this.#state = "stopped";
  }

  #isDraining(projectId: string): boolean {
    return [...this.#retiring.keys()].some(
      (worker) => worker.projectId === projectId,
    );
  }

  #projectStatus(projectId: string): ProjectWorkerStatus | null {
    const worker =
      this.#workers.get(projectId) ??
      [...this.#retiring.keys()].find(
        (retired) => retired.projectId === projectId,
      );
    return worker?.status() ?? null;
  }

  #assertAccepting(): void {
    if (!this.#started || this.#stopping) {
      throw new WorkerNotRunningError(this.#instance);
    }
  }

  #bindBaseUrl(baseUrl: string): void {
    const saved = this.#store.getInstance(this.#instance);
    if (!saved) {
      this.#store.saveInstance({
        instance: this.#instance,
        baseUrl,
        maxConcurrency: this.#maxConcurrency,
      });
      return;
    }
    if (saved.baseUrl !== baseUrl) {
      throw new WorkerBaseUrlMismatchError(
        this.#instance,
        saved.baseUrl,
        baseUrl,
      );
    }
  }

  #applyMachineLimit(limit: number): void {
    this.#slots.setMachineLimit(limit);
    this.#maxConcurrency = limit;
  }

  #activeRuns(projectId?: string): ActiveRunStatus[] {
    return this.#runRegistry
      .list(projectId === undefined ? {} : { projectId })
      .map((run) => ({
        taskRunId: run.taskRunId,
        projectId: run.projectId,
        taskName: run.taskName,
        phase: run.phase,
        startedAt: run.startedAt.toISOString(),
      }));
  }
}

function assertNonNegativeInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer.`);
  }
}
