import { describe, expect, test, vi } from "bun:test";
import { createUuidV7 } from "@/common/contracts/uuid-v7";
import type { ConversationRepo } from "@/conversations/conversation/application/conversation-repo";
import { ConversationEntity } from "@/conversations/conversation/domain/conversation-entity";
import {
  onTaskEnded,
  type OnTaskEndedDeps,
} from "@/tasks/task/application/on-task-ended";
import type { TaskRepo } from "@/tasks/task/application/task-repo";
import { TaskEntity, type TaskStatus } from "@/tasks/task/domain/task-entity";
import { fixedTimeProvider } from "tests/utils";
import { LATER, NOW, tx } from "./on-run-ended-fixtures";

const setup = (onWorkItem: boolean, status: TaskStatus) => {
  const projectId = createUuidV7();
  const workItemId = onWorkItem ? createUuidV7() : null;
  const conversation = ConversationEntity.start({
    projectId,
    workItemId,
    now: NOW,
  });
  const task = TaskEntity.create({
    projectId,
    workItemId,
    conversationId: conversation.id,
    kind: "agent",
    prompt: "How does checkout work?",
    status,
    createdAt: NOW,
  });
  const save = vi.fn((next: ConversationEntity) => Promise.resolve(next));
  const deps: OnTaskEndedDeps = {
    taskRepo: {} as TaskRepo,
    grantRequestRepo: {
      findPendingByTaskId: () => Promise.resolve(null),
      save: vi.fn(),
    },
    taskRunRepo: {
      listByTaskId: () => Promise.resolve([]),
      clearSessions: () => Promise.resolve(),
    },
    conversationRepo: {
      lock: () => Promise.resolve(conversation),
      save,
      listMessages: () => Promise.resolve([]),
    } as unknown as ConversationRepo,
    workItemCommentRepo: { create: vi.fn() },
    timeProvider: fixedTimeProvider(LATER),
    taskGroup: { ended: vi.fn(() => Promise.resolve()) },
  };
  return { task, deps, save };
};

describe("onTaskEnded, a chat (no work item)", () => {
  test.concurrent(
    "a failed chat keeps its conversation open for a retry",
    async () => {
      const { task, deps, save } = setup(false, "failed");
      await onTaskEnded(task, null, deps, tx);
      expect(save).not.toHaveBeenCalled();
    },
  );

  test.concurrent("a cancelled chat closes its conversation", async () => {
    const { task, deps, save } = setup(false, "cancelled");
    await onTaskEnded(task, null, deps, tx);
    expect(save.mock.calls[0]?.[0].isClosed).toBe(true);
  });

  test.concurrent(
    "a failed Task on a work item still closes its conversation",
    async () => {
      const { task, deps, save } = setup(true, "failed");
      await onTaskEnded(task, null, deps, tx);
      expect(save.mock.calls[0]?.[0].isClosed).toBe(true);
    },
  );
});
