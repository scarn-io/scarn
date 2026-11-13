/**
 * A {@link SlotPort} that borrows run slots from a running background worker
 * over its control API (`/slots/*`), so a foreground `scarn worker start
 * --once` shares the machine limit with it.
 *
 * The port holds one lease. The first acquire opens it; later acquires and
 * releases pass its id. A heartbeat renews it every `heartbeatMs` while it
 * is open, so held slots outlive the server's TTL. If the server forgets the
 * lease (it expired, or the worker restarted), the slots it held are already
 * back with the worker: the port drops its count and the next acquire opens
 * a new lease.
 *
 * `changed()` long-polls `/slots/changed` from the newest generation the
 * port has seen when it is called. Each acquire reports the generation the
 * server had before granting, so a release that lands between a
 * subscription and the acquire after it still wakes the subscriber.
 */
import type { SlotPort } from "../contracts/slot-port";
import { MAX_SLOTS_CHANGED_WAIT_MS } from "../contracts/control-api";
import type { ControlClient } from "./control-client";

export const DEFAULT_SLOT_HEARTBEAT_MS = 10_000;
export const DEFAULT_SLOT_RETRY_MS = 1_000;

export type RemoteSlotPortOptions = {
  client: ControlClient;
  heartbeatMs?: number | undefined;
  /** Long-poll length per `/slots/changed` request; at most 30s. */
  waitMs?: number | undefined;
  /** Pause before re-polling after a failed `/slots/changed`. */
  retryMs?: number | undefined;
};

/** Raised when the worker answers a slot request with an error. */
export class RemoteSlotError extends Error {
  override readonly name = "RemoteSlotError";

  constructor(
    readonly operation: string,
    readonly status: number,
    readonly detail: unknown,
  ) {
    super(
      `Slot ${operation} failed with status ${String(status)}: ${JSON.stringify(detail)}`,
    );
  }
}

type EdenError = { status: number; value: unknown } | null;

function isLeaseNotFound(error: EdenError): boolean {
  return (
    error?.status === 404 &&
    typeof error.value === "object" &&
    error.value !== null &&
    (error.value as { code?: unknown }).code === "lease_not_found"
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export class RemoteSlotPort implements SlotPort {
  readonly #client: ControlClient;
  readonly #waitMs: number;
  readonly #retryMs: number;
  readonly #held = new Map<string, number>();
  readonly #closing = new AbortController();
  readonly #heartbeat: ReturnType<typeof setInterval>;
  #leaseId: string | undefined;
  #generation = 0;
  #acquiring: Promise<void> = Promise.resolve();

  constructor(options: RemoteSlotPortOptions) {
    this.#client = options.client;
    this.#waitMs = Math.min(
      options.waitMs ?? MAX_SLOTS_CHANGED_WAIT_MS,
      MAX_SLOTS_CHANGED_WAIT_MS,
    );
    this.#retryMs = options.retryMs ?? DEFAULT_SLOT_RETRY_MS;
    this.#heartbeat = setInterval(() => {
      void this.heartbeat().catch(() => undefined);
    }, options.heartbeatMs ?? DEFAULT_SLOT_HEARTBEAT_MS);
    this.#heartbeat.unref();
  }

  /** Slots this port holds per project. */
  held(): ReadonlyMap<string, number> {
    return this.#held;
  }

  /** Acquires run one at a time, so concurrent first acquires share one lease. */
  acquire(projectId: string, wanted: number): Promise<number> {
    const next = this.#acquiring.then(() => this.#acquire(projectId, wanted));
    this.#acquiring = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #acquire(projectId: string, wanted: number): Promise<number> {
    if (this.#closing.signal.aborted) return 0;
    let response = await this.#client.slots.acquire.post({
      leaseId: this.#leaseId,
      projectId,
      wanted,
    });
    if (this.#leaseId !== undefined && isLeaseNotFound(response.error)) {
      this.#dropLease();
      response = await this.#client.slots.acquire.post({ projectId, wanted });
    }
    if (!response.data) {
      throw new RemoteSlotError("acquire", response.status, response.error);
    }
    const { leaseId, granted, generation } = response.data;
    this.#leaseId = leaseId;
    this.#generation = Math.max(this.#generation, generation);
    if (granted > 0) {
      this.#held.set(projectId, (this.#held.get(projectId) ?? 0) + granted);
    }
    return granted;
  }

  async release(projectId: string, count: number): Promise<void> {
    const held = this.#held.get(projectId) ?? 0;
    const returned = Math.min(count, held);
    const leaseId = this.#leaseId;
    if (returned === 0 || leaseId === undefined) return;
    if (returned === held) this.#held.delete(projectId);
    else this.#held.set(projectId, held - returned);
    const response = await this.#client.slots.release.post({
      leaseId,
      projectId,
      count: returned,
    });
    if (isLeaseNotFound(response.error)) {
      this.#dropLease();
      return;
    }
    if (response.error) {
      throw new RemoteSlotError("release", response.status, response.error);
    }
  }

  async changed(signal?: AbortSignal): Promise<void> {
    const since = this.#generation;
    const stop = signal
      ? AbortSignal.any([signal, this.#closing.signal])
      : this.#closing.signal;
    while (!stop.aborted) {
      const response = await this.#client.slots.changed
        .post({ since, waitMs: this.#waitMs }, { fetch: { signal: stop } })
        .catch(() => null);
      if (response?.data) {
        if (response.data.changed) {
          this.#generation = Math.max(
            this.#generation,
            response.data.generation,
          );
          return;
        }
        continue;
      }
      await sleep(this.#retryMs, stop);
    }
  }

  /** Renews the lease now; drops it when the worker no longer knows it. */
  async heartbeat(): Promise<void> {
    const leaseId = this.#leaseId;
    if (leaseId === undefined) return;
    const response = await this.#client.slots({ leaseId }).heartbeat.post();
    if (isLeaseNotFound(response.error) && this.#leaseId === leaseId) {
      this.#dropLease();
    }
  }

  /** Stops the heartbeat, ends pending waits and hands every slot back. */
  async close(): Promise<void> {
    if (this.#closing.signal.aborted) return;
    this.#closing.abort();
    clearInterval(this.#heartbeat);
    const held = [...this.#held];
    await Promise.all(
      held.map(([projectId, count]) =>
        this.release(projectId, count).catch(() => undefined),
      ),
    );
    this.#leaseId = undefined;
  }

  #dropLease(): void {
    this.#leaseId = undefined;
    this.#held.clear();
  }
}
