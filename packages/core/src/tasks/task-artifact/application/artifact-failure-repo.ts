import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { ArtifactFailureContract } from "../contracts/task-artifact-failure-contracts";
import type { ArtifactKind } from "../contracts/task-artifact-contracts";

export type RecordArtifactFailureRow = {
  id: UuidV7;
  taskRunId: UuidV7;
  projectId: UuidV7;
  relativeStorePath: string;
  attemptedSizeBytes: number;
  kind: ArtifactKind;
  errorCode: string;
  errorMessage: string;
  httpStatus: number | null;
};

export type ArtifactFailureRepo = {
  /** Persist a new artifact-upload-failure row and return its contract projection. */
  record(
    input: RecordArtifactFailureRow,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactFailureContract>;
  /** List all upload failures recorded for a task, newest first. */
  listByTask(
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactFailureContract[]>;
  /**
   * Hard-deletes failure rows whose `createdAt` is older than
   * `now - retentionDays` (the sole aging anchor). Unlike
   * {@link ArtifactRepo.clearExpiredArtifacts}, there are no bytes to null
   * out — the row itself is deleted outright. Returns the number of rows
   * deleted. Limited to `orgId`'s projects when given.
   */
  deleteExpiredFailures(
    now: Date,
    retentionDays: number,
    dbExecutor?: DbExecutor,
    orgId?: UuidV7,
  ): Promise<number>;
};
