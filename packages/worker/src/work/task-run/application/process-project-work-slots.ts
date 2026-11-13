import type { SlotPort } from "../../worker-host/contracts/slot-port";
import { SlotAllocator } from "../../worker-host/domain/slot-allocator";
import { resolveProjectWorkLogger } from "./process-project-work-logger";
import type {
  ProcessProjectWorkDeps,
  ProcessProjectWorkInput,
} from "../contracts/process-project-work-types";

/**
 * One project loop's view of its {@link SlotPort}: it reserves slots before
 * claiming, hands back the unused ones, and releases one slot per run once
 * the run settles. Without an injected port the loop gets a private
 * allocator with `machineLimit = concurrency`, which is the old per-loop cap.
 */
export class ProjectSlots {
  readonly #port: SlotPort;
  readonly #input: ProcessProjectWorkInput;
  readonly #deps: ProcessProjectWorkDeps;
  readonly #pendingReleases = new Set<Promise<void>>();
  #subscription: AbortController | null = null;
  #nextChange: Promise<void> = Promise.resolve();

  constructor(input: ProcessProjectWorkInput, deps: ProcessProjectWorkDeps) {
    this.#input = input;
    this.#deps = deps;
    this.#port =
      input.slots ?? new SlotAllocator({ machineLimit: input.concurrency });
  }

  /**
   * Reserves up to `batchSize` slots. It subscribes to slot changes first,
   * so if nothing is free, {@link waitForChange} cannot miss a release that
   * landed while `acquire` was answering.
   */
  async acquireBatch(): Promise<number> {
    this.#unsubscribe();
    const subscription = new AbortController();
    this.#subscription = subscription;
    const drainSignal = this.#input.drainSignal;
    this.#nextChange = this.#port.changed(
      drainSignal
        ? AbortSignal.any([subscription.signal, drainSignal])
        : subscription.signal,
    );
    const reserved = await this.#port.acquire(
      this.#input.projectId,
      this.#input.batchSize,
    );
    if (reserved > 0) this.#unsubscribe();
    return reserved;
  }

  /** Waits until slots are freed, a limit changes, or the loop drains. */
  async waitForChange(): Promise<void> {
    try {
      await this.#nextChange;
    } finally {
      this.#unsubscribe();
    }
  }

  async release(count: number): Promise<void> {
    if (count <= 0) return;
    await this.#port.release(this.#input.projectId, count);
  }

  /** Releases one slot once `job` settles, whether it succeeded or not. */
  releaseWhenSettled(job: Promise<void>, taskRunId: string): void {
    const pending = (async () => {
      await Promise.allSettled([job]);
      try {
        await this.release(1);
      } catch (error: unknown) {
        resolveProjectWorkLogger(this.#deps).error(
          "worker",
          "Failed to release run slot",
          {
            projectId: this.#input.projectId,
            workerId: this.#input.workerId,
            taskRunId,
            error,
          },
        );
      }
    })();
    this.#pendingReleases.add(pending);
    void pending.finally(() => this.#pendingReleases.delete(pending));
  }

  /** Settles once every run's slot has been handed back. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.#pendingReleases]);
  }

  #unsubscribe(): void {
    this.#subscription?.abort();
    this.#subscription = null;
  }
}
