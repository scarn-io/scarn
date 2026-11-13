import { randomUUID } from "node:crypto";
import type { SlotPort } from "../contracts/slot-port";

export const DEFAULT_SLOT_LEASE_TTL_MS = 30_000;

/** Raised for a lease id that never existed or has already expired. */
export class SlotLeaseNotFoundError extends Error {
  override readonly name = "SlotLeaseNotFoundError";

  constructor(readonly leaseId: string) {
    super(`Slot lease ${leaseId} does not exist or has expired.`);
  }
}

export type SlotLeaseTimer = {
  every(ms: number, tick: () => void): { cancel(): void };
};

export type SlotLeaseManagerOptions = {
  slots: SlotPort;
  ttlMs?: number | undefined;
  now?: (() => number) | undefined;
  timer?: SlotLeaseTimer | undefined;
};

export type SlotLeaseGrant = {
  leaseId: string;
  granted: number;
  expiresAt: string;
  generation: number;
};

type SlotLease = {
  held: Map<string, number>;
  expiresAt: number;
};

const intervalTimer: SlotLeaseTimer = {
  every(ms, tick) {
    const handle = setInterval(tick, ms);
    handle.unref();
    return {
      cancel: () => {
        clearInterval(handle);
      },
    };
  },
};

/**
 * Lends slots of the worker's shared allocator to borrowers in another
 * process (a foreground `scarn work --once`). Each borrower holds one lease;
 * every acquire, release or heartbeat renews it for `ttlMs`. A lease that is
 * not renewed in time expires and its slots go back, so a borrower that
 * crashed never holds slots for long.
 *
 * `generation` counts slot changes (a release or a limit change). A remote
 * borrower passes the generation it last saw to {@link waitForChange}, so a
 * change that lands between its acquire and its wait is not missed.
 */
export class SlotLeaseManager {
  readonly #slots: SlotPort;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #leases = new Map<string, SlotLease>();
  readonly #watching = new AbortController();
  readonly #sweeper: { cancel(): void };
  #generation = 0;
  #waiters = new Set<() => void>();

  constructor(options: SlotLeaseManagerOptions) {
    this.#slots = options.slots;
    this.#ttlMs = options.ttlMs ?? DEFAULT_SLOT_LEASE_TTL_MS;
    this.#now = options.now ?? Date.now;
    const timer = options.timer ?? intervalTimer;
    this.#sweeper = timer.every(
      Math.max(1, Math.floor(this.#ttlMs / 3)),
      () => {
        this.sweep();
      },
    );
    void this.#watch();
  }

  get generation(): number {
    return this.#generation;
  }

  /** Reserves up to `wanted` slots for `projectId`; opens a lease if none is given. */
  async acquire(input: {
    leaseId?: string | undefined;
    projectId: string;
    wanted: number;
  }): Promise<SlotLeaseGrant> {
    const generation = this.#generation;
    const leaseId = input.leaseId ?? randomUUID();
    const lease =
      input.leaseId === undefined
        ? { held: new Map<string, number>(), expiresAt: 0 }
        : this.#lease(input.leaseId);
    const granted = await this.#slots.acquire(input.projectId, input.wanted);
    if (granted > 0) {
      lease.held.set(
        input.projectId,
        (lease.held.get(input.projectId) ?? 0) + granted,
      );
    }
    this.#leases.set(leaseId, lease);
    return {
      leaseId,
      granted,
      expiresAt: this.#renew(lease),
      generation,
    };
  }

  /** Hands `count` of the lease's slots for `projectId` back. */
  async release(input: {
    leaseId: string;
    projectId: string;
    count: number;
  }): Promise<{ expiresAt: string }> {
    const lease = this.#lease(input.leaseId);
    const held = lease.held.get(input.projectId) ?? 0;
    if (!Number.isInteger(input.count) || input.count < 0) {
      throw new RangeError("count must be a non-negative integer.");
    }
    if (input.count > held) {
      throw new RangeError(
        `Lease ${input.leaseId} holds ${String(held)} slot(s) of project ${input.projectId}; it cannot release ${String(input.count)}.`,
      );
    }
    if (input.count === held) lease.held.delete(input.projectId);
    else lease.held.set(input.projectId, held - input.count);
    await this.#slots.release(input.projectId, input.count);
    return { expiresAt: this.#renew(lease) };
  }

  heartbeat(leaseId: string): { expiresAt: string } {
    return { expiresAt: this.#renew(this.#lease(leaseId)) };
  }

  /**
   * Resolves once the generation is past `since` (at once if it already
   * is), or after `waitMs`, or when `signal` aborts.
   */
  async waitForChange(
    since: number,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<{ changed: boolean; generation: number }> {
    if (this.#generation > since || waitMs === 0 || signal?.aborted) {
      return this.#changedSince(since);
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", done);
        this.#waiters.delete(done);
        resolve();
      };
      const timeout = setTimeout(done, waitMs);
      signal?.addEventListener("abort", done, { once: true });
      this.#waiters.add(done);
    });
    return this.#changedSince(since);
  }

  /** Expires every lease past its deadline and returns its slots. */
  sweep(): void {
    const now = this.#now();
    for (const [leaseId, lease] of this.#leases) {
      if (lease.expiresAt <= now) {
        void this.#expire(leaseId, lease).catch(() => undefined);
      }
    }
  }

  /** Stops the sweeper and returns every lent slot. */
  async close(): Promise<void> {
    this.#sweeper.cancel();
    this.#watching.abort();
    await Promise.all(
      [...this.#leases].map(([leaseId, lease]) => this.#expire(leaseId, lease)),
    );
    for (const wake of [...this.#waiters]) wake();
  }

  async #expire(leaseId: string, lease: SlotLease): Promise<void> {
    this.#leases.delete(leaseId);
    for (const [projectId, count] of lease.held) {
      await this.#slots.release(projectId, count);
    }
    lease.held.clear();
  }

  async #watch(): Promise<void> {
    const { signal } = this.#watching;
    while (!signal.aborted) {
      await this.#slots.changed(signal);
      if (this.#closed()) return;
      this.#generation += 1;
      for (const wake of [...this.#waiters]) wake();
    }
  }

  #closed(): boolean {
    return this.#watching.signal.aborted;
  }

  #changedSince(since: number): { changed: boolean; generation: number } {
    return { changed: this.#generation > since, generation: this.#generation };
  }

  #lease(leaseId: string): SlotLease {
    const lease = this.#leases.get(leaseId);
    if (!lease || lease.expiresAt <= this.#now()) {
      throw new SlotLeaseNotFoundError(leaseId);
    }
    return lease;
  }

  #renew(lease: SlotLease): string {
    lease.expiresAt = this.#now() + this.#ttlMs;
    return new Date(lease.expiresAt).toISOString();
  }
}
