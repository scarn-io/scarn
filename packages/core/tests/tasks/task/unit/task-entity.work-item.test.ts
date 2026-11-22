import { describe, expect, test } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError } from "@/lib/errors";
import { TaskEntity } from "@/tasks/task/domain/task-entity";
import { NOW } from "./on-run-ended-fixtures";

const create = (workItemId: string | null, conversationId: string | null) =>
  TaskEntity.create({
    projectId: createUuidV7(),
    workItemId: workItemId as TaskEntity["workItemId"],
    conversationId: conversationId as TaskEntity["conversationId"],
    kind: "agent",
    prompt: "Explain the repo.",
    status: "queued",
    createdAt: NOW,
  });

describe("a Task's work item", () => {
  test.concurrent(
    "a Task with a conversation and no work item has runs with no work item",
    () => {
      const conversationId = createUuidV7();
      const task = create(null, conversationId);

      expect(task.workItemId).toBeNull();
      expect(task.conversationId).toBe(conversationId);
      expect(
        task.newRun({
          number: 1,
          reason: "initial",
          status: "queued",
          now: NOW,
        }).workItemId,
      ).toBeNull();
    },
  );

  test.concurrent("a Task needs a work item or a conversation", () => {
    expect(() => create(null, null)).toThrow(CoreValidationError);
  });
});
