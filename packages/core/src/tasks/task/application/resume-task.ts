/**
 * What a person's action on a waiting Task shares: replying, continuing and
 * deciding a grant request all resume it with a `continuation` run.
 */
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  CoreValidationError,
  InvariantViolationError,
} from "@scarn/core/lib/errors";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import type { ConversationWriteDeps } from "@scarn/core/conversations/conversation/application/send-conversation-message";
import type { GrantRequestRepo } from "@scarn/core/tasks/grant-request/application/grant-request-repo";
import { markGrantRequestUnanswered } from "@scarn/core/tasks/grant-request/domain/grant-request";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { WorkNotifier } from "@scarn/core/tasks/task-run/application/work-notifier";
import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import { latestBaseCommit } from "../domain/base-commit";
import { latestEnvironmentVersion } from "../domain/environment-version";
import type { TaskEntity } from "../domain/task-entity";
import type { OnTaskEndedDeps } from "./on-task-ended";
import type { TaskOutcomePort } from "./task-outcome-port";
import type { TaskPipelineRunPort } from "./task-pipeline-run-port";
import type { TaskRepo } from "./task-repo";

export type ActOnTaskDeps = ConversationWriteDeps & {
  taskRepo: TaskRepo;
  grantRequestRepo: Pick<
    GrantRequestRepo,
    "load" | "findPendingByTaskId" | "save"
  >;
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

/** Locks the Task of `conversationId`, which must wait for a person. */
export const lockWaitingTask = async (
  conversationId: UuidV7,
  deps: Pick<ActOnTaskDeps, "taskRepo">,
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
export const runsOf = async (
  task: TaskEntity,
  deps: ActOnTaskDeps,
  tx: DbExecutor,
) =>
  (await deps.taskRunRepo.listByTaskId(task.id, tx)).sort(
    (left, right) => left.number - right.number,
  );

export const latestRun = (
  task: TaskEntity,
  runs: TaskRunEntity[],
): TaskRunEntity => {
  const latest = runs.at(-1);
  if (!latest) {
    throw new InvariantViolationError(
      `Task ${task.id} waits for a person with no run`,
      "TASK_RUN_MISSING",
    );
  }
  return latest;
};

/** The acting person's username, or "Someone". */
export const actorName = async (deps: ActOnTaskDeps, tx: DbExecutor) =>
  (
    await deps.usernameReader.loadUsernamesByUserId(
      [deps.userAuthz.actorId],
      tx,
    )
  ).get(deps.userAuthz.actorId)?.username ?? "Someone";

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

/** Closes the Task's `pending` grant request, if any, as `unanswered`. */
const closeUnansweredRequest = async (
  task: TaskEntity,
  deps: ActOnTaskDeps,
  tx: DbExecutor,
): Promise<void> => {
  const pending = await deps.grantRequestRepo.findPendingByTaskId(task.id, tx);
  if (pending) {
    await deps.grantRequestRepo.save(markGrantRequestUnanswered(pending), tx);
  }
};

/**
 * Queues the Task's `continuation` run, which carries on from the yielded
 * run's work branch (else the Task's first base branch), and tells
 * `taskOutcomePort` the Task resumed. A grant request still `pending` (the
 * person replied or continued without deciding it) closes `unanswered`.
 */
export const resume = async (
  task: TaskEntity,
  deps: ActOnTaskDeps,
  tx: DbExecutor,
): Promise<void> => {
  await closeUnansweredRequest(task, deps, tx);
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
