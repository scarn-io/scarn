import { TaskRunCancelledError } from "./task-run-cancelled-error";
import { WorkerStoppedError } from "./worker-stopped-error";

/** Where a run is in its lifecycle on this worker. */
export type RunPhase = "launching" | "running" | "tearing_down";

/**
 * Why a run was aborted. `cancelled` ends it quietly, as if the server had
 * revoked the claim. `worker_stopped` ends it and reports it as failed with
 * the `WORKER_STOPPED` code.
 */
export type RunAbortReason = "cancelled" | "worker_stopped";

/** A snapshot of one run in a {@link RunRegistry}. */
export type RunEntry = {
  taskRunId: string;
  projectId: string;
  taskName: string | null;
  phase: RunPhase;
  startedAt: Date;
  abort(reason: RunAbortReason): void;
};

/**
 * The run's own view of its registry entry: the launch and monitor code
 * report the phase through it and watch `signal` for an abort.
 */
export type RunHandle = {
  readonly signal: AbortSignal;
  abortReason(): RunAbortReason | null;
  setPhase(phase: RunPhase): void;
  setTaskName(taskName: string): void;
  /**
   * The error matching the abort reason, or null if the run was not aborted.
   * An aborted run ends with this error, whatever the abort made the
   * in-flight work throw.
   */
  abortError(): Error | null;
  /** Throws {@link abortError}, if the run was aborted. */
  throwIfAborted(): void;
};

type RegisteredRun = {
  taskRunId: string;
  projectId: string;
  taskName: string | null;
  phase: RunPhase;
  startedAt: Date;
  reason: RunAbortReason | null;
  controller: AbortController;
  job: Promise<void>;
};

/**
 * The runs in flight on this worker, keyed by `taskRunId`. Each run gets an
 * `AbortController`; aborting it stops the run from inside the process. A
 * run leaves the registry as soon as its job settles. One registry can be
 * shared by several project loops, which then filter by `projectId`.
 */
export class RunRegistry {
  readonly #runs = new Map<string, RegisteredRun>();
  readonly #now: () => Date;
  #abortNewRunsWith: RunAbortReason | null = null;

  constructor(options: { now?: (() => Date) | undefined } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Registers a run and starts `execute` with its handle. The returned job
   * settles with `execute`, after the run has left the registry.
   */
  start(
    input: { taskRunId: string; projectId: string },
    execute: (handle: RunHandle) => Promise<void>,
  ): Promise<void> {
    if (this.#runs.has(input.taskRunId)) {
      throw new Error(`Task run ${input.taskRunId} is already registered.`);
    }
    const controller = new AbortController();
    const run: RegisteredRun = {
      taskRunId: input.taskRunId,
      projectId: input.projectId,
      taskName: null,
      phase: "launching",
      startedAt: this.#now(),
      reason: null,
      controller,
      job: Promise.resolve(),
    };
    const handle: RunHandle = {
      signal: controller.signal,
      abortReason: () => run.reason,
      setPhase: (phase) => {
        run.phase = phase;
      },
      setTaskName: (taskName) => {
        run.taskName = taskName;
      },
      abortError: () => abortErrorFor(run),
      throwIfAborted: () => {
        const error = abortErrorFor(run);
        if (error) throw error;
      },
    };
    this.#runs.set(run.taskRunId, run);
    if (this.#abortNewRunsWith) abortRun(run, this.#abortNewRunsWith);
    run.job = (async () => {
      try {
        await execute(handle);
      } finally {
        this.#runs.delete(run.taskRunId);
      }
    })();
    return run.job;
  }

  /**
   * Aborts a run. The first reason wins; later aborts are ignored. Returns
   * false when no such run is registered.
   */
  abort(taskRunId: string, reason: RunAbortReason): boolean {
    const run = this.#runs.get(taskRunId);
    if (!run) return false;
    abortRun(run, reason);
    return true;
  }

  /**
   * Aborts every run, and every run started from now on, with `reason`.
   * For a forced stop: a claim already in flight when the stop began still
   * ends promptly. Returns how many runs were in flight.
   */
  abortAll(reason: RunAbortReason): number {
    this.#abortNewRunsWith ??= reason;
    for (const run of this.#runs.values()) abortRun(run, reason);
    return this.#runs.size;
  }

  get(taskRunId: string): RunEntry | null {
    const run = this.#runs.get(taskRunId);
    return run ? toEntry(run) : null;
  }

  list(filter: { projectId?: string } = {}): RunEntry[] {
    return this.#select(filter).map(toEntry);
  }

  count(filter: { projectId?: string } = {}): number {
    return this.#select(filter).length;
  }

  /** The jobs of the matching runs, for awaiting them to settle. */
  jobs(filter: { projectId?: string } = {}): Promise<void>[] {
    return this.#select(filter).map((run) => run.job);
  }

  #select(filter: { projectId?: string }): RegisteredRun[] {
    const runs = [...this.#runs.values()];
    return filter.projectId === undefined
      ? runs
      : runs.filter((run) => run.projectId === filter.projectId);
  }
}

function abortRun(run: RegisteredRun, reason: RunAbortReason): void {
  if (run.reason !== null) return;
  run.reason = reason;
  run.controller.abort(reason);
}

function toEntry(run: RegisteredRun): RunEntry {
  return {
    taskRunId: run.taskRunId,
    projectId: run.projectId,
    taskName: run.taskName,
    phase: run.phase,
    startedAt: run.startedAt,
    abort: (reason) => {
      abortRun(run, reason);
    },
  };
}

function abortErrorFor(run: RegisteredRun): Error | null {
  switch (run.reason) {
    case "cancelled":
      return new TaskRunCancelledError(run.taskRunId);
    case "worker_stopped":
      return new WorkerStoppedError(run.taskRunId);
    case null:
      return null;
  }
}

/**
 * Sleeps through `sleep`, but returns as soon as `signal` aborts so an abort
 * takes effect without waiting out the interval.
 */
export async function sleepUnlessAborted(
  deps: { sleep(milliseconds: number, signal?: AbortSignal): Promise<void> },
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    await deps.sleep(milliseconds);
    return;
  }
  if (signal.aborted) return;
  const loser = new AbortController();
  try {
    await Promise.race([
      deps.sleep(milliseconds, loser.signal),
      abortedOrNever(signal, loser.signal),
    ]);
  } finally {
    loser.abort();
  }
}

/** Resolves when `signal` aborts, or never if `loser` aborts first. */
export function abortedOrNever(
  signal: AbortSignal,
  loser: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    signal.addEventListener(
      "abort",
      () => {
        resolve();
      },
      { once: true, signal: loser },
    );
  });
}
