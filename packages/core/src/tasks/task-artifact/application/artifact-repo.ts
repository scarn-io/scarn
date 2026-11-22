import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type {
  ArtifactContract,
  ArtifactKind,
} from "../contracts/task-artifact-contracts";

export type RecordArtifactRow = {
  id: UuidV7;
  taskRunId: UuidV7;
  projectId: UuidV7;
  relativeStorePath: string;
  objectKey: string;
  storeRef: string;
  sizeBytes: number;
  contentType: string | null;
  kind: ArtifactKind;
};

/** An artifact row (deleted or not) joined to the node run that produced it. */
export type ArtifactWithRunContext = ArtifactContract & {
  deletedAt: string | null;
  pipelineRunId: UuidV7 | null;
  attemptNumber: number | null;
  nodeKey: string | null;
};

export type ArtifactRepo = {
  /** Persist a new artifact metadata row and return its contract projection. */
  record(
    input: RecordArtifactRow,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactContract>;
  /** List all artifacts recorded for a task, newest first. */
  listByTask(
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactContract[]>;
  /** Load a single artifact by its id, or null when it does not exist. */
  findById(
    artifactId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactContract | null>;
  /**
   * Load an artifact by id including soft-deleted rows, with the pipeline
   * run, attempt and node key of the step that produced it (null when the
   * task is not part of a pipeline run).
   */
  findWithRunContextById(
    artifactId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactWithRunContext | null>;
  /**
   * List up to `limit + 1` active (non-deleted) artifacts for a project,
   * newest first, each annotated with the originating node's key for display.
   * Callers slice to `limit` and treat a `limit + 1`-length result as
   * "more exist" — avoids a separate COUNT query for the capped v1 list.
   */
  listByProjectId(
    projectId: UuidV7,
    limit: number,
    dbExecutor?: DbExecutor,
  ): Promise<Array<ArtifactContract & { nodeKey: string | null }>>;
  /** Load multiple artifacts by id (existing rows only; missing ids are simply absent from the result), for delete's pre-flight IDOR/ownership check. */
  findManyByIds(
    artifactIds: UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<ArtifactContract[]>;
  /**
   * Soft-deletes the given artifacts: sets `deletedAt` and nulls
   * `objectKey`/`storeRef`/`sizeBytes`/`contentType` (the same shape
   * {@link clearExpiredArtifacts} uses for expiry), skipping any id that is
   * already soft-deleted. Returns the ids actually deleted.
   */
  softDeleteMany(
    artifactIds: UuidV7[],
    deletedAt: Date,
    dbExecutor?: DbExecutor,
  ): Promise<UuidV7[]>;
  /**
   * Nulls out `objectKey`/`storeRef`/`sizeBytes`/`contentType` for artifacts
   * whose `createdAt` is older than `now - retentionDays` (the aging anchor —
   * artifacts have no separate "archived at" column since they are set once
   * and never rewritten). This mirrors the S3 lifecycle deletion in the
   * database so the download-URL endpoint 404s for expired artifacts and so a
   * subsequent reconciliation no longer counts them. Returns the number of
   * rows cleared. Idempotent: already-cleared rows (null store ref) are
   * skipped. Limited to `orgId`'s projects when given.
   */
  clearExpiredArtifacts(
    now: Date,
    retentionDays: number,
    dbExecutor?: DbExecutor,
    orgId?: UuidV7,
  ): Promise<number>;
};
