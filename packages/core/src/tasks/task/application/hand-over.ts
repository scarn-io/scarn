import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { InvariantViolationError } from "@scarn/core/lib/errors";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { ConversationRepo } from "@scarn/core/conversations/conversation/application/conversation-repo";
import { ConversationEntity } from "@scarn/core/conversations/conversation/domain/conversation-entity";
import { ConversationMessageEntity } from "@scarn/core/conversations/conversation/domain/conversation-message-entity";
import {
  notifyWaitingForPerson,
  type NotifyWaitingForPersonDeps,
} from "@scarn/core/notifications/user-notification/application/notify-waiting-for-person";
import { notifyRepoConversation } from "@scarn/core/notifications/user-notification/application/notify-repo-conversation";
import { agentMessageBody } from "@scarn/core/conversations/conversation/domain/agent-message-body";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import { loadWorkItemWaitingOnUserIds } from "@scarn/core/work-items/work-item/application/load-work-item-waiting-on";
import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type { TaskEntity } from "../domain/task-entity";
import type { TaskPipelineRunPort } from "./task-pipeline-run-port";
import type { TaskRepo } from "./task-repo";

export type HandOverDeps = {
  taskRepo: TaskRepo;
  conversationRepo: ConversationRepo;
  workItemRepo: Pick<WorkItemRepo, "load">;
  notifications: NotifyWaitingForPersonDeps;
  taskPipelineRun: TaskPipelineRunPort;
  timeProvider: TimeProvider;
};

const openConversation = async (
  task: TaskEntity,
  deps: HandOverDeps,
  now: Date,
  tx: DbExecutor,
): Promise<TaskEntity> => {
  if (task.conversationId === null) {
    const conversation = await deps.conversationRepo.create(
      ConversationEntity.start({
        projectId: task.projectId,
        workItemId: task.workItemId,
        now,
      }),
      tx,
    );
    return await deps.taskRepo.save(
      task.withConversation(conversation.id, now),
      tx,
    );
  }
  const conversation = await deps.conversationRepo.lock(
    task.conversationId,
    tx,
  );
  if (!conversation) {
    throw new InvariantViolationError(
      `Conversation ${task.conversationId} of Task ${task.id} is missing`,
      "TASK_CONVERSATION_MISSING",
    );
  }
  await deps.conversationRepo.save(conversation.awaitPerson(now), tx);
  return task;
};

/**
 * The agent of `task` handed the conversation to a person with `message`,
 * the final message of `run`: opens the Task's conversation on its first
 * hand-over (or gives the floor back to a person), posts the message, cut
 * by `agentMessageBody`, and tells the work item's assignee, its creator and
 * whoever started the Task (a pipeline Task's run starter) that Scarn waits
 * on them. Who it waits on isn't stored: Task reads derive it the same way.
 * A chat (no work item) only tells its creator, content-free, that the
 * answer is ready (`notifyRepoConversation`). Returns the Task with its
 * conversation.
 */
export const handOver = async (
  task: TaskEntity,
  run: TaskRunEntity,
  message: string,
  deps: HandOverDeps,
  tx: DbExecutor,
): Promise<TaskEntity> => {
  const now = deps.timeProvider.now();
  const [workItem, pipelineRun] = await Promise.all([
    task.workItemId === null
      ? Promise.resolve(null)
      : deps.workItemRepo.load(parseWorkItemId(task.workItemId), tx),
    deps.taskPipelineRun.findForTask(task.id, tx),
  ]);
  const recipientUserIds = await loadWorkItemWaitingOnUserIds(
    workItem,
    pipelineRun ? pipelineRun.startedByUserId : task.startedByUserId,
    deps.workItemRepo,
    tx,
  );
  const withConversation = await openConversation(task, deps, now, tx);
  const conversationId = withConversation.conversationId as UuidV7;
  const { body } = agentMessageBody(message);
  await deps.conversationRepo.insertMessage(
    ConversationMessageEntity.agent({
      conversationId,
      taskRunId: run.id,
      body,
      createdAt: now,
    }),
    tx,
  );
  if (task.workItemId === null) {
    await notifyRepoConversation(
      {
        event: "answer_ready",
        projectId: task.projectId,
        taskId: task.id,
        conversationId,
        recipientUserId: task.startedByUserId,
        now,
      },
      deps.notifications,
      tx,
    );
    return withConversation;
  }
  await notifyWaitingForPerson(
    {
      projectId: task.projectId,
      workItemId: task.workItemId,
      workItemTitle: workItem?.title ?? null,
      pipelineExecutionId: pipelineRun?.pipelineRunId ?? null,
      taskId: task.id,
      body,
      subject: { conversationId, source: "agent" },
      recipientUserIds,
      now,
    },
    deps.notifications,
    tx,
  );
  return withConversation;
};
