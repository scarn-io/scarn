import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TaskMessageEntity } from "../domain/task-message-entity";

export type TaskMessageRepo = {
  create(
    taskMessage: TaskMessageEntity,
    dbExecutor?: DbExecutor,
  ): Promise<TaskMessageEntity>;
  /** Messages on the given Tasks, oldest first. */
  listByTaskIds(
    taskIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<TaskMessageEntity[]>;
};
