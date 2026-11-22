import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TaskExecutionConfigEntity } from "../domain/task-execution-config-entity";

export type TaskExecutionConfigRepo = {
  load(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<TaskExecutionConfigEntity | null>;
  loadMany(
    ids: UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<TaskExecutionConfigEntity[]>;
  /**
   * Returns the project's row with the same content hash as `config`,
   * inserting `config` when there is none (D7). Safe under concurrent calls
   * with the same content.
   */
  findOrCreate(
    config: TaskExecutionConfigEntity,
    dbExecutor?: DbExecutor,
  ): Promise<TaskExecutionConfigEntity>;
};
