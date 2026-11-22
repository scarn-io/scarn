import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";

/** How one artifact field of a Task's result resolved. */
export type TaskArtifactResolution = {
  taskRunId: UuidV7;
  /** Dot path of the field in the result, e.g. `evidence.video`. */
  resultPath: string;
  artifactId: UuidV7 | null;
  unavailableReason: string | null;
};

export type TaskArtifactResolutionRepo = {
  /** Replaces every resolution recorded for the task. */
  replaceForTask(
    taskRunId: UuidV7,
    resolutions: TaskArtifactResolution[],
    dbExecutor?: DbExecutor,
  ): Promise<void>;
  listByTask(
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<TaskArtifactResolution[]>;
};
