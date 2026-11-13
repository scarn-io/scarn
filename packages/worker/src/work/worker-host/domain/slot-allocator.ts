import type { SlotPort } from "../contracts/slot-port";

/** What one project holds, and its own limit (`null` = machine limit only). */
export type ProjectSlotUsage = {
  projectId: string;
  limit: number | null;
  inUse: number;
};

/** A point-in-time view of a {@link SlotAllocator}. */
export type SlotSnapshot = {
  machineLimit: number;
  machineInUse: number;
  projects: ProjectSlotUsage[];
};

type ProjectSlots = { limit: number | null; inUse: number };

/**
 * Hands out run slots on one machine, shared by every project loop in the
 * worker. A project gets
 * `min(wanted, projectLimit − projectInUse, machineLimit − machineInUse)`,
 * never less than 0.
 *
 * Lowering a limit never takes slots back from runs already going; it only
 * shrinks what later `acquire` calls get, so `inUse` can sit above a limit
 * until those runs settle.
 *
 * `acquire` answers at once with what is free. Loops that got nothing wait
 * on {@link changed}; waiters are woken in the order they subscribed, so the
 * loop that has waited longest retries first (first-come, first-served).
 *
 * Pure and synchronous: no I/O, no timers.
 */
export class SlotAllocator implements SlotPort {
  #machineLimit: number;
  #machineInUse = 0;
  readonly #projects = new Map<string, ProjectSlots>();
  #waiters: (() => void)[] = [];

  constructor(options: { machineLimit: number }) {
    assertNonNegativeInt(options.machineLimit, "machineLimit");
    this.#machineLimit = options.machineLimit;
  }

  acquire(projectId: string, wanted: number): number {
    assertNonNegativeInt(wanted, "wanted");
    const project = this.#projects.get(projectId);
    const projectInUse = project?.inUse ?? 0;
    const projectLimit = project?.limit ?? Number.POSITIVE_INFINITY;
    const granted = Math.max(
      0,
      Math.min(
        wanted,
        projectLimit - projectInUse,
        this.#machineLimit - this.#machineInUse,
      ),
    );
    if (granted === 0) return 0;
    this.#project(projectId).inUse += granted;
    this.#machineInUse += granted;
    return granted;
  }

  release(projectId: string, count: number): void {
    assertNonNegativeInt(count, "count");
    if (count === 0) return;
    const project = this.#projects.get(projectId);
    if (!project || project.inUse < count) {
      throw new Error(
        `Project ${projectId} cannot release ${String(count)} slot(s); it holds ${String(project?.inUse ?? 0)}.`,
      );
    }
    project.inUse -= count;
    this.#machineInUse -= count;
    this.#forgetIfIdle(projectId, project);
    this.#notify();
  }

  setMachineLimit(limit: number): void {
    assertNonNegativeInt(limit, "machineLimit");
    this.#machineLimit = limit;
    this.#notify();
  }

  setProjectLimit(projectId: string, limit: number | null): void {
    if (limit !== null) assertNonNegativeInt(limit, "projectLimit");
    const project = this.#project(projectId);
    project.limit = limit;
    this.#forgetIfIdle(projectId, project);
    this.#notify();
  }

  snapshot(): SlotSnapshot {
    return {
      machineLimit: this.#machineLimit,
      machineInUse: this.#machineInUse,
      projects: [...this.#projects].map(([projectId, project]) => ({
        projectId,
        limit: project.limit,
        inUse: project.inUse,
      })),
    };
  }

  changed(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        this.#waiters = this.#waiters.filter((waiter) => waiter !== wake);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(wake);
    });
  }

  #project(projectId: string): ProjectSlots {
    let project = this.#projects.get(projectId);
    if (!project) {
      project = { limit: null, inUse: 0 };
      this.#projects.set(projectId, project);
    }
    return project;
  }

  #forgetIfIdle(projectId: string, project: ProjectSlots): void {
    if (project.inUse === 0 && project.limit === null) {
      this.#projects.delete(projectId);
    }
  }

  #notify(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }
}

function assertNonNegativeInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer.`);
  }
}
