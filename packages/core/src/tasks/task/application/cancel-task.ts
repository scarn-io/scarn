/**
 * A person stops an agent or MCP tool Task: the Task ends `cancelled`, with its open run
 * cancelled or, while it waits, with no run to cancel. A Task a pipeline
 * step visit owns is stopped by cancelling that run through
 * `TaskPipelineRunCancelPort`, which `pipeline-executions/` implements; this
 * module never calls into pipelines itself.
 */
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { assertNever } from "@scarn/core/lib/assert-never";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  CoreValidationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import {
  withTaskSessionCleanup,
  type SessionCleanupDeps,
} from "@scarn/core/tasks/task-run/application/delete-task-sessions";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import {
  getTaskInputSchema,
  type GetTaskInput,
} from "../contracts/task-contracts";
import type { TaskEntity } from "../domain/task-entity";
import { onRunEnded, type OnRunEndedDeps } from "./on-run-ended";
import { isTaskEnded, onTaskEnded } from "./on-task-ended";
import { noopTaskOutcomePort } from "./task-outcome-port";
import type { TaskPipelineRunPort } from "./task-pipeline-run-port";

/** Cancels the pipeline run a Task's step visit belongs to, in its own transaction. */
export type TaskPipelineRunCancelPort = {
  cancelRun(pipelineRunId: UuidV7): Promise<void>;
};

export type CancelStandaloneDeps = Omit<OnRunEndedDeps, "taskOutcomePort"> & {
  taskRunRepo: Pick<TaskRunRepo, "listByTaskId" | "create" | "save">;
};

export type CancelTaskDeps = CancelStandaloneDeps &
  SessionCleanupDeps & {
    userAuthz: UserAuthorizationService;
    taskPipelineRun: TaskPipelineRunPort;
    pipelineRunCancel: TaskPipelineRunCancelPort;
    dbExecutor?: DbExecutor | undefined;
  };

const assertCancellable = (task: TaskEntity): void => {
  switch (task.kind) {
    case "agent":
    case "mcp_tool":
      break;
    case "code":
      throw new CoreValidationError(
        `Task ${task.id} is a code Task, which can't be stopped`,
        "TASK_CANCEL_CODE_TASK",
      );
    default:
      assertNever(task.kind);
  }
  if (isTaskEnded(task)) {
    throw new CoreValidationError(
      `Task ${task.id} has already ended (status: ${task.status})`,
      "TASK_ALREADY_ENDED",
    );
  }
};

/**
 * Cancels a standalone Task's open run (revoking its claim), or the Task
 * itself while it waits; either way the Task ends `cancelled` through
 * `onTaskEnded`. `task` must be locked in `tx` and not have ended.
 */
export const cancelStandalone = async (
  task: TaskEntity,
  deps: CancelStandaloneDeps,
  tx: DbExecutor,
): Promise<void> => {
  const now = deps.timeProvider.now();
  const waiting = task.cancelWaiting(now);
  if (waiting !== task) {
    await onTaskEnded(await deps.taskRepo.save(waiting, tx), null, deps, tx);
    return;
  }
  const open = (await deps.taskRunRepo.listByTaskId(task.id, tx)).filter(
    (run) => !run.hasOutcome(),
  );
  for (const run of open) {
    const cancelled = await deps.taskRunRepo.save(
      run.withStatus("cancelled", now, { completedAt: now, clearClaim: true }),
      tx,
    );
    await onRunEnded(
      cancelled,
      { ...deps, taskOutcomePort: noopTaskOutcomePort },
      tx,
    );
  }
};

/**
 * Stops an agent or MCP tool Task (`POST /tasks/:taskId/cancel`). Needs
 * `executions:write` on its project. A code Task is refused
 * (`TASK_CANCEL_CODE_TASK`), and so is a Task that already ended
 * (`TASK_ALREADY_ENDED`). A pipeline step's Task cancels its whole run.
 */
export const cancelTask = async (
  input: GetTaskInput,
  deps: CancelTaskDeps,
): Promise<Result<{ taskId: UuidV7 }, ResourceNotFoundError>> => {
  const taskId = getTaskInputSchema.parse(input);
  const db = deps.dbExecutor ?? getDb();
  const task = await deps.taskRepo.load(taskId, db);
  if (!task) {
    return Result.err(new ResourceNotFoundError("Task", taskId));
  }
  await deps.userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "executions:write",
    dbExecutor: db,
  });
  assertCancellable(task);
  const pipelineRun = await deps.taskPipelineRun.findForTask(task.id, db);
  if (pipelineRun) {
    await deps.pipelineRunCancel.cancelRun(pipelineRun.pipelineRunId);
    return Result.ok({ taskId: task.id });
  }
  await withTaskSessionCleanup(deps, (endedTaskSessions) =>
    db.transaction(async (tx) => {
      const locked = await deps.taskRepo.load(task.id, tx);
      if (!locked) {
        throw new ResourceNotFoundError("Task", taskId);
      }
      assertCancellable(locked);
      await cancelStandalone(locked, { ...deps, endedTaskSessions }, tx);
    }),
  );
  return Result.ok({ taskId: task.id });
};
