import { describe, expect, test } from "bun:test";
import { SlotAllocator } from "../../../../src/work/worker-host/domain/slot-allocator";

async function isSettled(promise: Promise<void>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return settled;
}

describe("SlotAllocator", () => {
  test("grants up to what is wanted while the machine has room", () => {
    const slots = new SlotAllocator({ machineLimit: 4 });

    expect(slots.acquire("a", 3)).toBe(3);
    expect(slots.acquire("a", 3)).toBe(1);
    expect(slots.acquire("a", 3)).toBe(0);
  });

  test("two projects cannot over-reserve the machine between them", () => {
    const slots = new SlotAllocator({ machineLimit: 3 });

    expect(slots.acquire("a", 2)).toBe(2);
    expect(slots.acquire("b", 2)).toBe(1);
    expect(slots.acquire("a", 1)).toBe(0);
    expect(slots.snapshot()).toEqual({
      machineLimit: 3,
      machineInUse: 3,
      projects: [
        { projectId: "a", limit: null, inUse: 2 },
        { projectId: "b", limit: null, inUse: 1 },
      ],
    });

    slots.release("a", 1);

    expect(slots.acquire("b", 5)).toBe(1);
    expect(slots.snapshot().machineInUse).toBe(3);
  });

  test("applies the per-project limit", () => {
    const slots = new SlotAllocator({ machineLimit: 10 });
    slots.setProjectLimit("a", 2);

    expect(slots.acquire("a", 5)).toBe(2);
    expect(slots.acquire("a", 1)).toBe(0);
    expect(slots.acquire("b", 5)).toBe(5);

    slots.setProjectLimit("a", null);

    expect(slots.acquire("a", 5)).toBe(3);
  });

  test("lowering a limit does not take slots back", () => {
    const slots = new SlotAllocator({ machineLimit: 4 });
    expect(slots.acquire("a", 4)).toBe(4);
    slots.setProjectLimit("a", 3);

    slots.setMachineLimit(2);

    expect(slots.snapshot()).toMatchObject({
      machineLimit: 2,
      machineInUse: 4,
    });
    expect(slots.acquire("a", 1)).toBe(0);
    expect(slots.acquire("b", 1)).toBe(0);

    slots.release("a", 1);
    expect(slots.acquire("b", 1)).toBe(0);

    slots.release("a", 2);
    expect(slots.acquire("b", 1)).toBe(1);
  });

  test("refuses to release more than a project holds", () => {
    const slots = new SlotAllocator({ machineLimit: 2 });
    slots.acquire("a", 1);

    expect(() => {
      slots.release("a", 2);
    }).toThrow();
    expect(() => {
      slots.release("b", 1);
    }).toThrow();
    expect(slots.snapshot().machineInUse).toBe(1);
  });

  test("rejects negative or fractional limits and counts", () => {
    expect(() => new SlotAllocator({ machineLimit: -1 })).toThrow(RangeError);
    const slots = new SlotAllocator({ machineLimit: 1 });

    expect(() => slots.acquire("a", 1.5)).toThrow(RangeError);
    expect(() => {
      slots.setProjectLimit("a", -2);
    }).toThrow(RangeError);
  });

  test("forgets projects that hold nothing and have no limit", () => {
    const slots = new SlotAllocator({ machineLimit: 2 });
    slots.acquire("a", 1);
    slots.release("a", 1);

    expect(slots.snapshot().projects).toEqual([]);
  });

  describe("changed()", () => {
    test("fires when slots are released", async () => {
      const slots = new SlotAllocator({ machineLimit: 1 });
      slots.acquire("a", 1);
      const change = slots.changed();

      expect(await isSettled(change)).toBe(false);
      slots.release("a", 1);
      expect(await isSettled(change)).toBe(true);
    });

    test("fires when the machine limit changes", async () => {
      const slots = new SlotAllocator({ machineLimit: 1 });
      const change = slots.changed();

      slots.setMachineLimit(2);

      expect(await isSettled(change)).toBe(true);
    });

    test("fires when a project limit changes", async () => {
      const slots = new SlotAllocator({ machineLimit: 1 });
      const change = slots.changed();

      slots.setProjectLimit("a", 1);

      expect(await isSettled(change)).toBe(true);
    });

    test("does not fire on acquire", async () => {
      const slots = new SlotAllocator({ machineLimit: 2 });
      const change = slots.changed();

      slots.acquire("a", 1);

      expect(await isSettled(change)).toBe(false);
    });

    test("wakes waiters in the order they subscribed", async () => {
      const slots = new SlotAllocator({ machineLimit: 1 });
      slots.acquire("a", 1);
      const woken: string[] = [];
      const first = slots.changed().then(() => woken.push("first"));
      const second = slots.changed().then(() => woken.push("second"));

      slots.release("a", 1);
      await Promise.all([first, second]);

      expect(woken).toEqual(["first", "second"]);
    });

    test("resolves when the signal aborts and drops the waiter", async () => {
      const slots = new SlotAllocator({ machineLimit: 1 });
      const controller = new AbortController();
      const change = slots.changed(controller.signal);

      controller.abort();

      expect(await isSettled(change)).toBe(true);
      expect(await isSettled(slots.changed(controller.signal))).toBe(true);
    });
  });
});
