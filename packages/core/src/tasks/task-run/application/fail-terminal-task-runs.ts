import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  onRunEnded,
  type OnRunEndedDeps,
} from "@scarn/core/tasks/task/application/on-run-ended";
import {
  getTaskRunInputSchema,
  type GetTaskRunInput,
  type TaskRunContract,
} from "../contracts/task-run-contracts";
import type { TaskRunEntity } from "../domain/task-run-entity";
import type { TaskRunRepo } from "./task-run-repo";
import { taskRunEntityToContract } from "./task-run-contract-mapper";
import {
  withTaskSessionCleanup,
  type SessionCleanupDeps,
} from "./delete-task-sessions";
import {
  buildAbandonedTaskRunError,
  buildTimedOutTaskRunError,
} from "./task-run-claim-helpers";

export type FailTerminalTaskRunDeps = OnRunEndedDeps &
  SessionCleanupDeps & {
    taskRunRepo: TaskRunRepo;
    dbExecutor?: DbExecutor | undefined;
  };

/**
 * Fails Tasks no worker will report on. The claim and heartbeat paths call
 * these through the injected handlers; the defaults are the plain task
 * functions, which tell `taskOutcomePort` themselves.
 */
export type TerminalTaskRunHandlers = {
  failTimedOut(
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<Result<TaskRunContract, ResourceNotFoundError>>;
  failAbandoned(
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<Result<TaskRunContract, ResourceNotFoundError>>;
};

const failTask = async (
  taskIdInput: GetTaskRunInput,
  status: "timeout" | "abandoned",
  buildError: (task: TaskRunEntity, now: Date) => TaskRunEntity["errorJson"],
  deps: FailTerminalTaskRunDeps,
): Promise<Result<TaskRunContract, ResourceNotFoundError>> => {
  const { taskRunRepo, timeProvider, dbExecutor } = deps;
  const taskRunId = getTaskRunInputSchema.parse(taskIdInput);
  const db = dbExecutor ?? getDb();

  return await withTaskSessionCleanup(deps, (endedTaskSessions) =>
    db.transaction(async (tx) => {
      const task = await taskRunRepo.lock(taskRunId, tx);
      if (!task) {
        return Result.err(new ResourceNotFoundError("Task", taskRunId));
      }
      if (task.hasOutcome()) {
        return Result.ok(taskRunEntityToContract(task));
      }

      const now = timeProvider.now();
      const failed = await taskRunRepo.save(
        task.failWith(status, buildError(task, now), now),
        tx,
      );
      await onRunEnded(failed, { ...deps, endedTaskSessions }, tx);
      return Result.ok(taskRunEntityToContract(failed));
    }),
  );
};

/**
 * Records a Task that ran past its execution deadline as `timeout`. Does
 * nothing when the Task already has an outcome, so it is safe to repeat.
 */
export const failTimedOutTaskRun = (
  taskIdInput: GetTaskRunInput,
  deps: FailTerminalTaskRunDeps,
) => failTask(taskIdInput, "timeout", buildTimedOutTaskRunError, deps);

/**
 * Records a Task whose worker stopped heartbeating (lease expired) as
 * `abandoned`. Does nothing when the Task already has an outcome.
 */
export const failAbandonedTaskRun = (
  taskIdInput: GetTaskRunInput,
  deps: FailTerminalTaskRunDeps,
) => failTask(taskIdInput, "abandoned", buildAbandonedTaskRunError, deps);

/** Handlers that fail the Task alone, for callers with no pipeline wiring. */
export const plainTerminalTaskRunHandlers = (
  deps: Omit<FailTerminalTaskRunDeps, "dbExecutor">,
): TerminalTaskRunHandlers => ({
  failTimedOut: (taskRunId, dbExecutor) =>
    failTimedOutTaskRun(taskRunId, { ...deps, dbExecutor }),
  failAbandoned: (taskRunId, dbExecutor) =>
    failAbandonedTaskRun(taskRunId, { ...deps, dbExecutor }),
});
