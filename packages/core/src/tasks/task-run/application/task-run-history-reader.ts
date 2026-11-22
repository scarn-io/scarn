import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TaskMessageEntity } from "@scarn/core/tasks/task-message/domain/task-message-entity";
import type { TaskRunStatus } from "../domain/task-run-entity";

export const TASK_RUN_HISTORY_MAX_ROWS = 500;

export type TaskRunHistoryEntry = {
  taskRunId: UuidV7;
  previousTaskRunId: UuidV7 | null;
  status: TaskRunStatus;
  createdAt: Date;
  messages: TaskMessageEntity[];
};

/**
 * Reads a Task's previous-run chain: the Task and every run before it, oldest
 * first, each with the messages attached to it. `status` has the liveness
 * overlay applied against `now`, the same as `TaskRunEntity.status`.
 */
export type TaskRunHistoryReader = {
  loadHistory(
    taskRunId: UuidV7,
    now: Date,
    dbExecutor?: DbExecutor,
  ): Promise<TaskRunHistoryEntry[]>;
};
