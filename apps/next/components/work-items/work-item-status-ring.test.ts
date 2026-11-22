import { describe, expect, test } from "bun:test";
import { workItemRingStatus } from "./work-item-status-ring";

const open = { state: "open" } as const;

describe("workItemRingStatus", () => {
  test("a closed item is closed whatever is waiting on it", () => {
    expect(
      workItemRingStatus(
        { state: "closed" },
        [{ status: "waiting_for_person", waitingOnYou: true }],
        [],
      ),
    ).toBe("closed");
  });

  test("a Task waiting on the viewer needs them", () => {
    expect(
      workItemRingStatus(
        open,
        [{ status: "waiting_for_person", waitingOnYou: true }],
        [],
      ),
    ).toBe("needs_you");
  });

  test("an open question waiting on the viewer needs them", () => {
    expect(
      workItemRingStatus(open, [], [{ status: "open", waitingOnYou: true }]),
    ).toBe("needs_you");
  });

  test("an answered question no longer needs the viewer", () => {
    expect(
      workItemRingStatus(
        open,
        [],
        [{ status: "answered", waitingOnYou: true }],
      ),
    ).toBe("open");
  });

  test("a live Task waiting on someone else is in progress", () => {
    expect(
      workItemRingStatus(
        open,
        [{ status: "waiting_for_person", waitingOnYou: false }],
        [],
      ),
    ).toBe("in_progress");
    expect(
      workItemRingStatus(
        open,
        [{ status: "running", waitingOnYou: false }],
        [],
      ),
    ).toBe("in_progress");
  });

  test("a Task waiting for its blockers or a concurrency slot isn't in progress", () => {
    expect(
      workItemRingStatus(
        open,
        [
          { status: "waiting_for_work", waitingOnYou: false },
          { status: "waiting_for_concurrency_slot", waitingOnYou: false },
        ],
        [],
      ),
    ).toBe("open");
  });

  test("only ended Tasks leave the item open", () => {
    expect(
      workItemRingStatus(
        open,
        [
          { status: "succeeded", waitingOnYou: false },
          { status: "failed", waitingOnYou: false },
        ],
        [],
      ),
    ).toBe("open");
  });
});
