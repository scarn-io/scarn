import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { PipelineGraphEntity } from "../domain/pipeline-graph-entity";
import type { PipelineGraphVersionEntity } from "../domain/pipeline-graph-version-entity";

export type ResolvedPipelineGraph = {
  handle: PipelineGraphEntity;
  currentVersion: PipelineGraphVersionEntity | null;
};

export type PipelineStepUse = {
  stepDefinitionId: UuidV7;
  pipeline: PipelineGraphEntity;
};

export type PipelineGraphRepo = {
  load(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ResolvedPipelineGraph | null>;
  loadHandle(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphEntity | null>;
  /** Loads the handle with `SELECT … FOR UPDATE`, serialising publishes and activations. */
  lockHandle(
    id: UuidV7,
    dbExecutor: DbExecutor,
  ): Promise<PipelineGraphEntity | null>;
  /** The unarchived pipeline with this key, else the most recently archived one. */
  findHandleByKey(
    projectId: UuidV7,
    key: string,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphEntity | null>;
  listByProjectId(
    projectId: UuidV7,
    options?: { includeArchived?: boolean | undefined },
    dbExecutor?: DbExecutor,
  ): Promise<ResolvedPipelineGraph[]>;
  /** Unarchived pipelines whose current version pins one of these exact step versions. */
  listCurrentByStepDefinitionIds(
    projectId: UuidV7,
    stepDefinitionIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<PipelineStepUse[]>;
  insertHandle(
    handle: PipelineGraphEntity,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphEntity>;
  updateHandle(
    handle: PipelineGraphEntity,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphEntity>;
};
