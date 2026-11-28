import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";

/** How an artifact field of a step's result resolved when its Task completed. */
export type RunArtifactResolution = {
  artifactId: UuidV7 | null;
  unavailableReason: string | null;
};

/** A `task_artifacts` row from a task in the run, deleted or not. */
export type RunArtifact = {
  id: UuidV7;
  relativeStorePath: string;
  contentType: string | null;
  kind: string;
  sizeBytes: number | null;
  /** Null once the artifact has expired. */
  storeRef: string | null;
  deletedAt: Date | null;
  createdAt: Date;
};

/**
 * A `task_artifact_bundles` row from a task in the run, deleted or not, with
 * its active (unrevoked) share's id.
 */
export type RunArtifactBundle = {
  id: UuidV7;
  name: string;
  fieldPath: string | null;
  status: "pending" | "ready" | "failed";
  createdAt: Date;
  expiredAt: Date | null;
  deletedAt: Date | null;
  activeShareId: UuidV7 | null;
};

/** Reads the artifact resolutions, artifacts and bundles a pipeline run produced. */
export interface CommentArtifactReader {
  /**
   * How the artifact field at `resultPath` resolved for the newest
   * non-superseded visit to `stepKey` (a node id, or the step key the node
   * runs) in the run, or null when no such visit recorded one.
   */
  findLatestStepArtifact(
    input: { pipelineRunId: UuidV7; stepKey: string; resultPath: string },
    dbExecutor?: DbExecutor,
  ): Promise<RunArtifactResolution | null>;
  /** Every artifact from every task in the run, newest first. */
  listRunArtifacts(
    pipelineRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<RunArtifact[]>;
  /**
   * The bundle filling the declared field `fieldPath` in the newest
   * non-superseded visit to `stepKey` (as {@link findLatestStepArtifact}),
   * or null when that visit's task runs submitted none.
   */
  findLatestStepBundle(
    input: { pipelineRunId: UuidV7; stepKey: string; fieldPath: string },
    dbExecutor?: DbExecutor,
  ): Promise<RunArtifactBundle | null>;
  /** Every bundle from every task in the run, newest first. */
  listRunBundles(
    pipelineRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<RunArtifactBundle[]>;
}
