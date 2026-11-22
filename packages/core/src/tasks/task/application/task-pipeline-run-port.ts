import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";

/** The pipeline run a Task's step visit belongs to, as the Task sees it. */
export type TaskPipelineRun = {
  pipelineRunId: UuidV7;
  startedByUserId: UuidV7 | null;
};

/** The branch a step visit's Task starts from: the nearest upstream work branch, or null. */
export type TaskVisitBaseBranch = { baseBranch: string | null };

/**
 * Finds the pipeline run whose step visit owns a Task; null for a
 * standalone Task. Implemented by `pipeline-executions/`.
 */
export type TaskPipelineRunPort = {
  findForTask(taskId: UuidV7, tx: DbExecutor): Promise<TaskPipelineRun | null>;
  /**
   * The base branch of the step visit that owns the Task, which a Task that
   * waited for a concurrency slot (and so has no run) needs for its first
   * run; null for a standalone Task.
   */
  findVisitBaseBranch(
    taskId: UuidV7,
    tx: DbExecutor,
  ): Promise<TaskVisitBaseBranch | null>;
};
