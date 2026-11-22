import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { getDb } from "@scarn/core/lib/db";
import { InvariantViolationError } from "@scarn/core/lib/errors";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { ManagedLaunchRepo } from "@scarn/core/connections/managed-mcp-connection/application/managed-launch-repo";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type { WorkNotifier } from "@scarn/core/tasks/task-run/application/work-notifier";
import {
  notifyRepoConversation,
  type NotifyRepoConversationDeps,
} from "@scarn/core/notifications/user-notification/application/notify-repo-conversation";
import { FAILED_RUN_STATUSES, retryDecision } from "../domain/retry-decision";
import { namedRunError } from "../domain/run-error";
import { latestBaseCommit } from "../domain/base-commit";
import { latestEnvironmentVersion } from "../domain/environment-version";
import type { TaskEntity } from "../domain/task-entity";
import { handOver, type HandOverDeps } from "./hand-over";
import {
  isTaskEnded,
  onTaskEnded,
  type OnTaskEndedDeps,
} from "./on-task-ended";
import type { TaskOutcomePort } from "./task-outcome-port";
import type { TaskRepo } from "./task-repo";

export type SyncTaskWithRunDeps = {
  taskRepo: TaskRepo;
  taskRunRepo: Pick<TaskRunRepo, "listByTaskId">;
  timeProvider: TimeProvider;
};

export type OnRunEndedDeps = SyncTaskWithRunDeps &
  OnTaskEndedDeps & {
    taskRunRepo: Pick<TaskRunRepo, "listByTaskId" | "create">;
    taskOutcomePort: TaskOutcomePort;
    workNotifier: WorkNotifier;
    notifications: NotifyRepoConversationDeps;
    managedLaunchRepo: Pick<
      ManagedLaunchRepo,
      "closeAllForRun" | "listOperations"
    >;
  };

/** The Task's `continuation` runs up to and including `run`. */
export const countContinuationRuns = async (
  run: Pick<TaskRunEntity, "taskId" | "number">,
  taskRunRepo: Pick<TaskRunRepo, "listByTaskId">,
  tx?: DbExecutor,
): Promise<number> =>
  (await taskRunRepo.listByTaskId(run.taskId, tx)).filter(
    (each) => each.reason === "continuation" && each.number <= run.number,
  ).length;

const loadTask = async (
  run: TaskRunEntity,
  taskRepo: TaskRepo,
  tx?: DbExecutor,
): Promise<TaskEntity> => {
  const task = tx
    ? await taskRepo.lock(run.taskId, tx)
    : await taskRepo.load(run.taskId);
  if (!task) {
    throw new InvariantViolationError(
      `Task ${run.taskId} of run ${run.id} is missing`,
      "TASK_MISSING",
    );
  }
  return task;
};

/**
 * Brings `run`'s Task in step with `run` (see `TaskEntity.followRun`) and
 * saves it when that changed it. Returns the Task before and after.
 */
export const syncTaskWithRun = async (
  run: TaskRunEntity,
  deps: SyncTaskWithRunDeps,
  tx?: DbExecutor,
): Promise<{ before: TaskEntity; after: TaskEntity }> => {
  if (!tx) {
    return await getDb().transaction((lockedTx) =>
      syncTaskWithRun(run, deps, lockedTx),
    );
  }
  const task = await loadTask(run, deps.taskRepo, tx);
  const runs = await deps.taskRunRepo.listByTaskId(run.taskId, tx);
  if (runs.some((each) => each.number > run.number)) {
    return { before: task, after: task };
  }
  const continuationRuns =
    run.status === "yielded" && task.maxTurns !== null
      ? await countContinuationRuns(run, deps.taskRunRepo, tx)
      : 0;
  const followed = task.followRun(
    run,
    deps.timeProvider.now(),
    continuationRuns,
  );
  return {
    before: task,
    after: followed === task ? task : await deps.taskRepo.save(followed, tx),
  };
};

/**
 * Whether `run` timed out or was abandoned while a relayed managed call was
 * still leased, so that call's outcome is unknown. A run that failed by
 * itself reported its own end, so only these two statuses are checked.
 */
const hasUnknownOperation = async (
  run: TaskRunEntity,
  deps: OnRunEndedDeps,
  tx: DbExecutor,
): Promise<boolean> =>
  (run.status === "timeout" || run.status === "abandoned") &&
  (await deps.managedLaunchRepo.listOperations(run.id, tx)).length > 0;

/**
 * The `retry` run the Task's retry policy gives a failed `run`, created; null
 * when `run` didn't fail, isn't the Task's latest run, or isn't retried
 * (see `retryDecision`, which also never retries a run left with an
 * unknown managed operation). Attempts are the Task's earlier failed runs. The retry starts from the
 * first run's base branch with the same input and a fresh session.
 */
const queueRetryRun = async (
  run: TaskRunEntity,
  deps: OnRunEndedDeps,
  tx: DbExecutor,
): Promise<TaskRunEntity | null> => {
  if (!FAILED_RUN_STATUSES.has(run.status)) {
    return null;
  }
  const task = await loadTask(run, deps.taskRepo, tx);
  if (task.retryJson === null) {
    return null;
  }
  const runs = await deps.taskRunRepo.listByTaskId(run.taskId, tx);
  const latest = Math.max(run.number, ...runs.map((each) => each.number));
  if (latest !== run.number) {
    return null;
  }
  const attempts = runs.filter(
    (each) => each.number < run.number && FAILED_RUN_STATUSES.has(each.status),
  ).length;
  const failure = {
    ...namedRunError(run),
    operationUnknown: await hasUnknownOperation(run, deps, tx),
  };
  if (!retryDecision(task.retryJson, failure, attempts).retry) {
    return null;
  }
  const first = runs.reduce<TaskRunEntity>(
    (earliest, each) => (each.number < earliest.number ? each : earliest),
    run,
  );
  const retry = await deps.taskRunRepo.create(
    task.newRun({
      number: run.number + 1,
      reason: "retry",
      status: "queued",
      baseBranch: first.baseBranch,
      baseCommit: latestBaseCommit([...runs, run]),
      environmentVersionId: latestEnvironmentVersion([...runs, run]),
      now: deps.timeProvider.now(),
    }),
    tx,
  );
  deps.workNotifier.enqueued(retry.projectId);
  return retry;
};

/** Tells a chat's creator its turn failed for good (no retry is left). */
const notifyChatFailed = async (
  task: TaskEntity,
  deps: OnRunEndedDeps,
  tx: DbExecutor,
): Promise<void> => {
  if (task.workItemId !== null || task.conversationId === null) {
    return;
  }
  await notifyRepoConversation(
    {
      event: "failed",
      projectId: task.projectId,
      taskId: task.id,
      conversationId: task.conversationId,
      recipientUserId: task.startedByUserId,
      now: deps.timeProvider.now(),
    },
    deps.notifications,
    tx,
  );
};

/** The final message of a run that yielded, and what handing it over needs. */
export type RunHandOver = { message: string; deps: HandOverDeps };

/**
 * Records how `run` ended on its Task. First it closes the run's open
 * managed launch connections, so their relay capabilities stop working in
 * the same transaction that ends the run. A failure the Task's retry policy
 * retries queues the next run and leaves the Task `queued`, unseen by
 * `taskOutcomePort`. A `hand_over` yield that left the Task waiting for a
 * person (it had turns left) posts `handOver.message` to the Task's
 * conversation first (`handOver`). A Task that ended goes through
 * `onTaskEnded`; a chat that failed tells its creator. Then
 * `taskOutcomePort` hears of the Task in `tx` when its status changed.
 * Returns the Task as saved.
 */
export const onRunEnded = async (
  run: TaskRunEntity,
  deps: OnRunEndedDeps,
  tx: DbExecutor,
  yielded?: RunHandOver,
): Promise<TaskEntity> => {
  await deps.managedLaunchRepo.closeAllForRun(
    run.id,
    deps.timeProvider.now(),
    tx,
  );
  const current = await loadTask(run, deps.taskRepo, tx);
  const runs = await deps.taskRunRepo.listByTaskId(run.taskId, tx);
  if (runs.some((each) => each.number > run.number)) {
    return current;
  }
  const retry = await queueRetryRun(run, deps, tx);
  if (retry !== null) {
    return (await syncTaskWithRun(retry, deps, tx)).after;
  }
  const { before, after: synced } = await syncTaskWithRun(run, deps, tx);
  let after = synced;
  if (run.status === "yielded" && synced.status === "waiting_for_person") {
    if (!yielded) {
      throw new InvariantViolationError(
        `Run ${run.id} handed over without its final message`,
        "TASK_HAND_OVER_MESSAGE_MISSING",
      );
    }
    after = await handOver(synced, run, yielded.message, yielded.deps, tx);
  }
  if (after.status !== before.status && isTaskEnded(after)) {
    after = await onTaskEnded(after, run, deps, tx);
    if (after.status === "failed") {
      await notifyChatFailed(after, deps, tx);
    }
  }
  if (after.status !== before.status) {
    await deps.taskOutcomePort.taskChanged(after, run, tx);
  }
  return after;
};
