import { describe, expect, test } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import { onRunEnded } from "@/tasks/task/application/on-run-ended";
import { TaskEntity } from "@/tasks/task/domain/task-entity";
import type { TaskRunEntity } from "@/tasks/task-run/domain/task-run-entity";
import { LATER, NOW, setup, tx } from "./on-run-ended-fixtures";

describe("onRunEnded: chat notifications", () => {
  const RETRY = [{ on: ["MergeConflict"], maxAttempts: 1 }];

  const buildChat = (retryJson: TaskEntity["retryJson"] = null) =>
    TaskEntity.create({
      projectId: createUuidV7(),
      workItemId: null,
      conversationId: createUuidV7(),
      kind: "agent",
      prompt: "How does checkout work?",
      startedByUserId: createUuidV7(),
      retryJson,
      status: "running",
      createdAt: NOW,
    });

  const failedRun = (
    task: TaskEntity,
    number: number,
    reason: TaskRunEntity["reason"],
  ) =>
    task
      .newRun({ number, reason, status: "queued", now: NOW })
      .markRunning(NOW)
      .complete("failed", LATER, {
        resultJson: null,
        errorJson: { name: "MergeConflict", message: "boom" },
      });

  test.concurrent(
    "a failure an automatic retry picks up tells nobody yet",
    async () => {
      const task = buildChat(RETRY);
      const run = failedRun(task, 1, "initial");
      const { deps, created, createNotification } = setup(task, [run]);

      await onRunEnded(run, deps, tx);

      expect(created).toHaveLength(1);
      expect(createNotification).not.toHaveBeenCalled();
    },
  );

  test.concurrent(
    "the failure that ends the chat warns its creator once, content-free",
    async () => {
      const task = buildChat(RETRY);
      const first = failedRun(task, 1, "initial");
      const run = failedRun(task, 2, "retry");
      const { deps, createNotification } = setup(task, [first, run]);

      const ended = await onRunEnded(run, deps, tx);

      expect(ended.status).toBe("failed");
      expect(createNotification).toHaveBeenCalledTimes(1);
      const notification = createNotification.mock.calls[0]?.[0];
      expect(notification).toMatchObject({
        kind: "warning",
        recipientUserId: task.startedByUserId,
        taskId: task.id,
        workItemId: null,
        payloadJson: { conversationId: task.conversationId },
      });
      expect(notification?.body).not.toContain("boom");
    },
  );

  test.concurrent(
    "an earlier run ending again after the chat moved on tells nobody",
    async () => {
      const task = buildChat();
      const run = failedRun(task, 1, "initial");
      const later = failedRun(task, 2, "continuation");
      const { deps, createNotification } = setup(task, [run, later]);

      await onRunEnded(run, deps, tx);

      expect(createNotification).not.toHaveBeenCalled();
    },
  );

  test.concurrent("a work item Task's failure isn't a chat's", async () => {
    const task = TaskEntity.create({
      projectId: createUuidV7(),
      workItemId: createUuidV7(),
      kind: "agent",
      prompt: "Fix the checkout crash.",
      startedByUserId: createUuidV7(),
      status: "running",
      createdAt: NOW,
    });
    const run = failedRun(task, 1, "initial");
    const { deps, createNotification } = setup(task, [run]);

    expect((await onRunEnded(run, deps, tx)).status).toBe("failed");
    expect(createNotification).not.toHaveBeenCalled();
  });
});
