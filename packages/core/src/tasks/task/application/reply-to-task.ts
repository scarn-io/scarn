/**
 * A person acts on a Task waiting for them in its conversation: replying or
 * continuing without a reply resumes it with a `continuation` run, and Done
 * ends a Task with no result schema. The messages go through
 * `conversations/`; `taskOutcomePort` hears of the Task.
 */
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import {
  postConversationSystemMessage,
  sendConversationMessage,
} from "@scarn/core/conversations/conversation/application/send-conversation-message";
import {
  conversationIdParamsSchema,
  type SendConversationMessageInput,
} from "@scarn/core/conversations/conversation/contracts/conversation-contracts";
import {
  ConversationTaskFailedError,
  type ConversationEntity,
} from "@scarn/core/conversations/conversation/domain/conversation-entity";
import { onTaskEnded } from "./on-task-ended";
import {
  actorName,
  latestRun,
  lockWaitingTask,
  resume,
  runsOf,
  type ActedOnTask,
  type ActOnTaskDeps,
} from "./resume-task";

/**
 * Locks the conversation for a person acting on it without writing, checks
 * `executions:write` on its project and that it waits for them.
 */
const lockForAction = async (
  input: { conversationId: string },
  deps: ActOnTaskDeps,
  tx: DbExecutor,
): Promise<Result<ConversationEntity, ResourceNotFoundError>> => {
  const { conversationId } = conversationIdParamsSchema.parse(input);
  const conversation = await deps.conversationRepo.lock(conversationId, tx);
  if (!conversation) {
    return Result.err(
      new ResourceNotFoundError("Conversation", conversationId),
    );
  }
  await deps.userAuthz.requireProjectPermission({
    projectId: conversation.projectId,
    permission: "executions:write",
    dbExecutor: tx,
  });
  conversation.assertWaitingForPerson();
  return Result.ok(conversation);
};

/**
 * A chat whose Task failed takes no replies (409 `CONVERSATION_TASK_FAILED`,
 * pointing to Retry): its conversation stays open for the retry, and a
 * reply would otherwise queue with no turn to answer it. Locks the Task
 * before the conversation, the order a yield takes them in.
 */
const refuseReplyToFailedChat = async (
  input: SendConversationMessageInput,
  deps: ActOnTaskDeps,
  tx: DbExecutor,
): Promise<void> => {
  const { conversationId } = conversationIdParamsSchema.parse(input);
  const task = await deps.taskRepo.lockByConversationId(conversationId, tx);
  if (task?.workItemId !== null || task.status !== "failed") {
    return;
  }
  await deps.userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "comments:write",
    dbExecutor: tx,
  });
  throw new ConversationTaskFailedError(conversationId);
};

/**
 * A person's message in a Task's conversation. The first one while the Task
 * waits resumes it; one sent while that turn is still pending joins it.
 * Refused while the agent has the floor, once the conversation is closed,
 * and on a failed chat. Needs `comments:write`. Runs in `tx`.
 */
export const replyToTask = async (
  input: SendConversationMessageInput,
  deps: ActOnTaskDeps,
  tx: DbExecutor,
): Promise<Result<ActedOnTask, ResourceNotFoundError>> => {
  await refuseReplyToFailedChat(input, deps, tx);
  const sent = await sendConversationMessage(input, deps, tx);
  if (!sent.ok) {
    return sent;
  }
  const conversationId = sent.value.conversation.id;
  if (sent.value.previousStatus === "waiting_for_person") {
    await resume(await lockWaitingTask(conversationId, deps, tx), deps, tx);
  }
  return Result.ok({ conversationId });
};

/**
 * Resumes a waiting Task with no reply: a `system` message saying so, then
 * its `continuation` run. Needs `executions:write`. Runs in `tx`.
 */
export const continueTask = async (
  input: { conversationId: string },
  deps: ActOnTaskDeps,
  tx: DbExecutor,
): Promise<Result<ActedOnTask, ResourceNotFoundError>> => {
  const locked = await lockForAction(input, deps, tx);
  if (!locked.ok) {
    return locked;
  }
  const conversation = locked.value;
  const task = await lockWaitingTask(conversation.id, deps, tx);
  await postConversationSystemMessage(
    conversation,
    `${await actorName(deps, tx)} chose to continue without a reply`,
    (current, now) => current.acceptPersonMessage(now),
    { ...deps, actorId: deps.userAuthz.actorId },
    tx,
  );
  await resume(task, deps, tx);
  return Result.ok({ conversationId: conversation.id });
};

/**
 * A person ends a waiting Task with no result schema (Done): a `system`
 * message, then the Task succeeds with `{ conversationId, summary }`, the
 * summary being the last agent message, and its conversation closes
 * (`onTaskEnded`). Needs `executions:write`. Runs in `tx`.
 */
export const endTask = async (
  input: { conversationId: string },
  deps: ActOnTaskDeps,
  tx: DbExecutor,
): Promise<Result<ActedOnTask, ResourceNotFoundError>> => {
  const locked = await lockForAction(input, deps, tx);
  if (!locked.ok) {
    return locked;
  }
  const conversation = locked.value;
  const task = await lockWaitingTask(conversation.id, deps, tx);
  const messages = await deps.conversationRepo.listMessages(
    conversation.id,
    tx,
  );
  const summary =
    messages.filter((message) => message.authorKind === "agent").at(-1)?.body ??
    "";
  const ended = task.endConversation(summary, deps.timeProvider.now());
  await postConversationSystemMessage(
    conversation,
    `${await actorName(deps, tx)} ended the conversation`,
    (current) => current,
    { ...deps, actorId: deps.userAuthz.actorId },
    tx,
  );
  const saved = await onTaskEnded(
    await deps.taskRepo.save(ended, tx),
    null,
    deps,
    tx,
  );
  await deps.taskOutcomePort.taskChanged(
    saved,
    latestRun(task, await runsOf(task, deps, tx)),
    tx,
  );
  return Result.ok({ conversationId: conversation.id });
};
