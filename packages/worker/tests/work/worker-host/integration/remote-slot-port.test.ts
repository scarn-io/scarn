import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SlotAllocator } from "../../../../src/work/worker-host/domain/slot-allocator";
import { createControlClient } from "../../../../src/work/worker-host/infra/control-client";
import {
  startControlServer,
  type ControlServer,
} from "../../../../src/work/worker-host/infra/control-server";
import { RemoteSlotPort } from "../../../../src/work/worker-host/infra/remote-slot-port";
import { FakeControlSupervisor } from "./helpers/fake-control-supervisor";

describe("RemoteSlotPort", () => {
  let dir: string;
  let supervisor: FakeControlSupervisor;
  let slots: SlotAllocator;
  let server: ControlServer;
  let ports: RemoteSlotPort[];

  const start = (leaseTtlMs?: number) => {
    server = startControlServer({
      supervisor,
      slots,
      version: "1.2.3",
      pid: 4242,
      startedAt: "2026-11-12T00:00:00.000Z",
      logFilePath: path.join(dir, "worker.log"),
      onStopRequested: () => undefined,
      leaseTtlMs,
    });
  };

  const port = (options: { heartbeatMs?: number } = {}) => {
    const created = new RemoteSlotPort({
      client: createControlClient(server),
      retryMs: 10,
      ...options,
    });
    ports.push(created);
    return created;
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "remote-slot-port-"));
    supervisor = new FakeControlSupervisor();
    slots = new SlotAllocator({ machineLimit: 3 });
    ports = [];
  });

  afterEach(async () => {
    await Promise.all(ports.map((created) => created.close()));
    supervisor.stopped.resolve(undefined);
    await server.close({ force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test("two borrowers can't exceed the machine limit", async () => {
    start();
    const first = port();
    const second = port();
    expect(await first.acquire("p1", 2)).toBe(2);
    expect(await second.acquire("p2", 2)).toBe(1);
    expect(await second.acquire("p2", 1)).toBe(0);
    expect(slots.snapshot().machineInUse).toBe(3);

    await first.release("p1", 1);
    expect(await second.acquire("p2", 1)).toBe(1);
    expect(second.held().get("p2")).toBe(2);
  });

  test("concurrent first acquires share one lease", async () => {
    start(60);
    const borrower = port({ heartbeatMs: 20 });
    const grants = await Promise.all([
      borrower.acquire("p1", 1),
      borrower.acquire("p2", 1),
    ]);
    expect(grants).toEqual([1, 1]);
    await Bun.sleep(150);
    expect(slots.snapshot().machineInUse).toBe(2);
  });

  test("the heartbeat keeps the lease alive past its TTL", async () => {
    start(60);
    const borrower = port({ heartbeatMs: 20 });
    expect(await borrower.acquire("p1", 2)).toBe(2);
    await Bun.sleep(200);
    expect(slots.snapshot().machineInUse).toBe(2);
    await borrower.release("p1", 2);
    expect(slots.snapshot().machineInUse).toBe(0);
  });

  test("a lost lease is dropped and the next acquire opens a new one", async () => {
    start(40);
    const borrower = port({ heartbeatMs: 10_000 });
    expect(await borrower.acquire("p1", 2)).toBe(2);
    await Bun.sleep(150);
    expect(slots.snapshot().machineInUse).toBe(0);

    expect(await borrower.acquire("p1", 1)).toBe(1);
    expect(borrower.held().get("p1")).toBe(1);
    expect(slots.snapshot().machineInUse).toBe(1);
  });

  test("closing hands every slot back", async () => {
    start();
    const borrower = port();
    await borrower.acquire("p1", 1);
    await borrower.acquire("p2", 1);
    expect(slots.snapshot().machineInUse).toBe(2);
    await borrower.close();
    expect(slots.snapshot().machineInUse).toBe(0);
    expect(await borrower.acquire("p1", 1)).toBe(0);
  });

  test("changed() wakes when another borrower releases", async () => {
    start();
    const holder = port();
    const waiter = port();
    await holder.acquire("p1", 3);
    const woke = waiter.changed();
    expect(await waiter.acquire("p2", 1)).toBe(0);
    let settled = false;
    void woke.then(() => {
      settled = true;
    });
    await Bun.sleep(30);
    expect(settled).toBe(false);
    await holder.release("p1", 1);
    await woke;
    expect(await waiter.acquire("p2", 1)).toBe(1);
  });

  test("changed() does not miss a release between subscribing and acquiring", async () => {
    start();
    const holder = port();
    const waiter = port();
    await holder.acquire("p1", 3);
    await waiter.acquire("p2", 0);
    const woke = waiter.changed();
    await holder.release("p1", 1);
    await holder.acquire("p1", 1);
    expect(await waiter.acquire("p2", 1)).toBe(0);
    await woke;
  });

  test("changed() resolves when its signal aborts", async () => {
    start();
    const borrower = port();
    const controller = new AbortController();
    const woke = borrower.changed(controller.signal);
    await Bun.sleep(20);
    controller.abort();
    await woke;
  });
});
