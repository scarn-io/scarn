/**
 * A person acts on a Task waiting for them in its conversation: replying or
 * continuing without a reply resumes it with a `continuation` run, and Done
 * ends a Task with no result schema. The messages go through
 * `conversations/`; `taskOutcomePort` hears of the Task.
 */
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  CoreValidationError,
  InvariantViolationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import {
  postConversationSystemMessage,
  sendConversationMessage,
  type ConversationWriteDeps,
} from "@scarn/core/conversations/conversation/application/send-conversation-message";
import {
  conversationIdParamsSchema,
  type SendConversationMessageInput,
} from "@scarn/core/conversations/conversation/contracts/conversation-contracts";
import {
  ConversationTaskFailedError,
  type ConversationEntity,
} from "@scarn/core/conversations/conversation/domain/conversation-entity";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { WorkNotifier } from "@scarn/core/tasks/task-run/application/work-notifier";
import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import { latestBaseCommit } from "../domain/base-commit";
import { latestEnvironmentVersion } from "../domain/environment-version";
import type { TaskEntity } from "../domain/task-entity";
import { onTaskEnded, type OnTaskEndedDeps } from "./on-task-ended";
import type { TaskOutcomePort } from "./task-outcome-port";
import type { TaskPipelineRunPort } from "./task-pipeline-run-port";
import type { TaskRepo } from "./task-repo";

export type ActOnTaskDeps = ConversationWriteDeps & {
  taskRepo: TaskRepo;
  workItemCommentRepo: OnTaskEndedDeps["workItemCommentRepo"];
  taskRunRepo: Pick<TaskRunRepo, "listByTaskId" | "create" | "clearSessions">;
  orgRepo?: OnTaskEndedDeps["orgRepo"];
  domainEventDispatcher?: OnTaskEndedDeps["domainEventDispatcher"];
  usernameReader: UsernameReader;
  taskOutcomePort: TaskOutcomePort;
  taskPipelineRun: TaskPipelineRunPort;
  endedTaskSessions?: OnTaskEndedDeps["endedTaskSessions"];
  taskGroup: OnTaskEndedDeps["taskGroup"];
  workNotifier: WorkNotifier;
};

/** The conversation a person acted on. */
export type ActedOnTask = { conversationId: UuidV7 };

const lockWaitingTask = async (
  conversationId: UuidV7,
  deps: ActOnTaskDeps,
  tx: DbExecutor,
): Promise<TaskEntity> => {
  const task = await deps.taskRepo.lockByConversationId(conversationId, tx);
  if (!task) {
    throw new InvariantViolationError(
      `Conversation ${conversationId} has no Task`,
      "CONVERSATION_TASK_MISSING",
    );
  }
  if (task.status !== "waiting_for_person") {
    throw new CoreValidationError(
      `Task ${task.id} isn't waiting for a person (status: ${task.status})`,
      "TASK_NOT_WAITING_FOR_PERSON",
    );
  }
  return task;
};

/** The Task's runs, oldest first. */
const runsOf = async (task: TaskEntity, deps: ActOnTaskDeps, tx: DbExecutor) =>
  (await deps.taskRunRepo.listByTaskId(task.id, tx)).sort(
    (left, right) => left.number - right.number,
  );

const latestRun = (task: TaskEntity, runs: TaskRunEntity[]): TaskRunEntity => {
  const latest = runs.at(-1);
  if (!latest) {
    throw new InvariantViolationError(
      `Task ${task.id} waits for a person with no run`,
      "TASK_RUN_MISSING",
    );
  }
  return latest;
};

/**
 * Queues the Task's `continuation` run, which carries on from the yielded
 * run's work branch (else the Task's first base branch), and tells
 * `taskOutcomePort` the Task resumed.
 */
const resume = async (
  task: TaskEntity,
  deps: ActOnTaskDeps,
  tx: DbExecutor,
): Promise<void> => {
  const runs = await runsOf(task, deps, tx);
  const yielded = latestRun(task, runs);
  const now = deps.timeProvider.now();
  const granted = await grantTurnIfStandalone(task, runs, now, deps, tx);
  const run = await deps.taskRunRepo.create(
    granted.newRun({
      number: yielded.number + 1,
      reason: "continuation",
      status: "queued",
      baseBranch: yielded.workBranch ?? runs[0]?.baseBranch ?? null,
      baseCommit: latestBaseCommit(runs),
      environmentVersionId: latestEnvironmentVersion(runs),
      now,
    }),
    tx,
  );
  deps.workNotifier.enqueued(run.projectId);
  const resumed = await deps.taskRepo.save(granted.followRun(run, now), tx);
  await deps.taskOutcomePort.taskResumed(resumed, run, tx);
};

/**
 * A standalone Task with one more turn when the continuation a person's
 * reply queues would leave it none, so a chat never gets stuck. A pipeline
 * step visit's Task keeps its node's `maxTurns`.
 */
const grantTurnIfStandalone = async (
  task: TaskEntity,
  runs: TaskRunEntity[],
  now: Date,
  deps: ActOnTaskDeps,
  tx: DbExecutor,
): Promise<TaskEntity> => {
  const continuationRuns =
    runs.filter((each) => each.reason === "continuation").length + 1;
  const granted = task.grantTurn(continuationRuns, now);
  if (
    granted === task ||
    (await deps.taskPipelineRun.findForTask(task.id, tx)) !== null
  ) {
    return task;
  }
  return granted;
};

const actorName = async (deps: ActOnTaskDeps, tx: DbExecutor) =>
  (
    await deps.usernameReader.loadUsernamesByUserId(
      [deps.userAuthz.actorId],
      tx,
    )
  ).get(deps.userAuthz.actorId)?.username ?? "Someone";

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
