import { describe, expect, test } from "bun:test";
import {
  childWorkItemStatus,
  type ChildWorkItemStatus,
} from "@/work-items/work-item/domain/child-work-item-status";
import {
  taskStatusValues,
  type TaskStatus,
} from "@/tasks/task/domain/task-entity";

const open = (latestTaskStatus: TaskStatus | null, hasOpenBlockers = false) =>
  childWorkItemStatus({ state: "open", hasOpenBlockers, latestTaskStatus });

describe("child work item status", () => {
  test("a closed item is closed, whatever its Task and blockers", () => {
    for (const latestTaskStatus of [null, ...taskStatusValues]) {
      for (const hasOpenBlockers of [false, true]) {
        expect(
          childWorkItemStatus({
            state: "closed",
            hasOpenBlockers,
            latestTaskStatus,
          }),
        ).toBe("closed");
      }
    }
  });

  test("a ready item that has never had a Task needs a person", () => {
    expect(open(null)).toBe("needs_person");
  });

  test("a blocked item that has never had a Task is blocked", () => {
    expect(open(null, true)).toBe("blocked");
  });

  test("an item whose latest Task failed needs a person", () => {
    expect(open("failed")).toBe("needs_person");
  });

  test("needs a person wins over blocked", () => {
    expect(open("failed", true)).toBe("needs_person");
    expect(open("cancelled", true)).toBe("needs_person");
    expect(open("waiting_for_person", true)).toBe("needs_person");
  });

  test("each latest Task status maps to one group", () => {
    const expected: Record<TaskStatus, ChildWorkItemStatus> = {
      waiting_for_concurrency_slot: "running",
      waiting_for_work: "running",
      queued: "running",
      running: "running",
      waiting_for_person: "needs_person",
      succeeded: "ready",
      failed: "needs_person",
      cancelled: "needs_person",
    };
    expect(
      Object.fromEntries(
        taskStatusValues.map((status) => [status, open(status)]),
      ),
    ).toEqual(expected);
  });

  test("a live Task on a blocked item is running", () => {
    expect(open("waiting_for_work", true)).toBe("running");
    expect(open("waiting_for_concurrency_slot", true)).toBe("running");
  });

  test("a succeeded latest Task leaves the item ready or blocked", () => {
    expect(open("succeeded")).toBe("ready");
    expect(open("succeeded", true)).toBe("blocked");
  });
});
