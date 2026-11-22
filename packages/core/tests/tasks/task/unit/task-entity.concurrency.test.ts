import { describe, expect, test } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError } from "@/lib/errors";
import type { TaskStatus } from "@/tasks/task/domain/task-entity";
import { buildTask, LATER } from "./on-run-ended-fixtures";

describe("TaskEntity waiting for a concurrency slot", () => {
  test.concurrent("a Task can be created waiting for a slot", () => {
    const task = buildTask("waiting_for_concurrency_slot");

    expect(task.status).toBe("waiting_for_concurrency_slot");
  });

  test.concurrent("admit queues it with run #1 on a ready work item", () => {
    const task = buildTask("waiting_for_concurrency_slot");
    const runId = createUuidV7();

    const admitted = task.admit({ blocked: false, now: LATER, runId });

    expect(admitted.task.status).toBe("queued");
    expect(admitted.task.updatedAt).toEqual(LATER);
    expect(admitted.run).toMatchObject({
      id: runId,
      taskId: task.id,
      number: 1,
      reason: "initial",
      status: "queued",
    });
  });

  test.concurrent(
    "admit leaves it waiting_for_work with no run on a blocked work item",
    () => {
      const admitted = buildTask("waiting_for_concurrency_slot").admit({
        blocked: true,
        now: LATER,
      });

      expect(admitted.task.status).toBe("waiting_for_work");
      expect(admitted.run).toBeNull();
    },
  );

  test.concurrent.each<TaskStatus>([
    "waiting_for_work",
    "queued",
    "running",
    "waiting_for_person",
    "succeeded",
    "failed",
    "cancelled",
  ])("admit refuses a %s Task", (status) => {
    try {
      buildTask(status).admit({ blocked: false, now: LATER });
      throw new Error("Expected a validation error");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CoreValidationError);
      expect((error as CoreValidationError).code).toBe(
        "TASK_NOT_WAITING_FOR_CONCURRENCY_SLOT",
      );
    }
  });

  test.concurrent("cancelWaiting cancels a Task waiting for a slot", () => {
    const cancelled = buildTask("waiting_for_concurrency_slot").cancelWaiting(
      LATER,
    );

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.updatedAt).toEqual(LATER);
  });
});
