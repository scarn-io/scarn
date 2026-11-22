import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";

/**
 * The context a notification created from a TaskRun's result is filed under.
 * `taskId` is the run's Task. `pipelineExecutionId` is set only when the Task
 * belongs to a pipeline run.
 */
export type NotificationProvenance = {
  projectId: UuidV7;
  taskId: UuidV7;
  workItemId: UuidV7 | null;
  pipelineExecutionId: UuidV7 | null;
};

export interface NotificationProvenanceReader {
  resolveFromTaskRun(
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<NotificationProvenance | null>;
}
