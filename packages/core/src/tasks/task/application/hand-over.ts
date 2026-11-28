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
import type { GrantRequestRepo } from "@scarn/core/tasks/grant-request/application/grant-request-repo";
import { newGrantRequest } from "@scarn/core/tasks/grant-request/domain/grant-request";
import { grantsNotHeld, type Grant } from "../domain/grants";

/** The agent asking for more work item grants with its hand-over. */
export type AgentGrantRequest = { reason: string; grants: Grant[] };

/** What the agent handed over with: its final message and any grant request. */
export type AgentHandOver = {
  message: string;
  grantRequest?: AgentGrantRequest | undefined;
};

/**
 * Inserts `requested` as the Task's `pending` grant request, without the
 * grants it already holds (`grantsNotHeld`). Returns its id, or null when
 * nothing is left to ask for: then it's a plain hand-over.
 */
const recordGrantRequest = async (
  task: TaskEntity,
  run: TaskRunEntity,
  requested: AgentGrantRequest | undefined,
  deps: HandOverDeps,
  now: Date,
  tx: DbExecutor,
): Promise<UuidV7 | null> => {
  if (!requested) {
    return null;
  }
  const grants = grantsNotHeld(task.grants, requested.grants);
  if (grants.length === 0) {
    return null;
  }
  const request = await deps.grantRequestRepo.insert(
    newGrantRequest({
      projectId: task.projectId,
      taskId: task.id,
      taskRunId: run.id,
      reason: requested.reason,
      requested: grants,
      now,
    }),
    tx,
  );
  return request.id;
};

export type HandOverDeps = {
  taskRepo: TaskRepo;
  grantRequestRepo: Pick<GrantRequestRepo, "insert">;
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
 *
 * A `grantRequest` is recorded `pending` (`recordGrantRequest`) and linked
 * from the agent's message, and the notification carries its
 * `grantRequestId`. When the message is empty, the request's reason is
 * posted instead.
 */
export const handOver = async (
  task: TaskEntity,
  run: TaskRunEntity,
  { message, grantRequest }: AgentHandOver,
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
  const grantRequestId = await recordGrantRequest(
    task,
    run,
    grantRequest,
    deps,
    now,
    tx,
  );
  const { body } = agentMessageBody(
    message.trim() === "" && grantRequest ? grantRequest.reason : message,
  );
  await deps.conversationRepo.insertMessage(
    ConversationMessageEntity.agent({
      conversationId,
      taskRunId: run.id,
      grantRequestId,
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
      grantRequestId,
      recipientUserIds,
      now,
    },
    deps.notifications,
    tx,
  );
  return withConversation;
};
