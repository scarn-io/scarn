import { afterEach, describe, expect, test } from "bun:test";
import {
  SlotLeaseManager,
  SlotLeaseNotFoundError,
} from "../../../../src/work/worker-host/application/slot-lease-manager";
import { SlotAllocator } from "../../../../src/work/worker-host/domain/slot-allocator";

function setup(ttlMs = 1_000) {
  let now = 0;
  let tick: () => void = () => undefined;
  const slots = new SlotAllocator({ machineLimit: 3 });
  const leases = new SlotLeaseManager({
    slots,
    ttlMs,
    now: () => now,
    timer: {
      every(_ms, onTick) {
        tick = onTick;
        return { cancel: () => undefined };
      },
    },
  });
  return {
    slots,
    leases,
    advance: (ms: number) => {
      now += ms;
      tick();
    },
  };
}

describe("SlotLeaseManager", () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
  });

  test("adds later acquires to the same lease", async () => {
    const { slots, leases } = setup();
    close = () => leases.close();
    const first = await leases.acquire({ projectId: "p", wanted: 1 });
    const second = await leases.acquire({
      leaseId: first.leaseId,
      projectId: "p",
      wanted: 1,
    });

    expect(second.leaseId).toBe(first.leaseId);
    expect(slots.snapshot().machineInUse).toBe(2);
  });

  test("returns the slots of a lease that is not renewed in time", async () => {
    const { slots, leases, advance } = setup(1_000);
    close = () => leases.close();
    const kept = await leases.acquire({ projectId: "p", wanted: 1 });
    const lost = await leases.acquire({ projectId: "q", wanted: 2 });

    advance(600);
    leases.heartbeat(kept.leaseId);
    advance(600);
    await Promise.resolve();

    expect(slots.snapshot().machineInUse).toBe(1);
    expect(() => leases.heartbeat(lost.leaseId)).toThrow(
      SlotLeaseNotFoundError,
    );
  });

  test("refuses to release more than the lease holds", async () => {
    const { leases } = setup();
    close = () => leases.close();
    const lease = await leases.acquire({ projectId: "p", wanted: 1 });

    let outcome: Error | null = null;
    try {
      await leases.release({
        leaseId: lease.leaseId,
        projectId: "p",
        count: 2,
      });
    } catch (error) {
      if (error instanceof Error) outcome = error;
    }
    expect(outcome).toBeInstanceOf(RangeError);
  });

  test("waitForChange answers at once for a change already seen", async () => {
    const { slots, leases } = setup();
    close = () => leases.close();
    const lease = await leases.acquire({ projectId: "p", wanted: 1 });
    await leases.release({ leaseId: lease.leaseId, projectId: "p", count: 1 });
    await Promise.resolve();

    expect(await leases.waitForChange(lease.generation, 10_000)).toEqual({
      changed: true,
      generation: lease.generation + 1,
    });
    expect(slots.snapshot().machineInUse).toBe(0);
  });

  test("waitForChange times out without a change", async () => {
    const { leases } = setup();
    close = () => leases.close();
    expect(await leases.waitForChange(leases.generation, 5)).toEqual({
      changed: false,
      generation: 0,
    });
  });

  test("close returns every lent slot", async () => {
    const { slots, leases } = setup();
    await leases.acquire({ projectId: "p", wanted: 2 });
    await leases.close();
    expect(slots.snapshot().machineInUse).toBe(0);
  });
});
