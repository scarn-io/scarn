import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { PipelineGraphVersionEntity } from "../domain/pipeline-graph-version-entity";

export type PipelineGraphVersionRepo = {
  load(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphVersionEntity | null>;
  loadMany(
    ids: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphVersionEntity[]>;
  loadByNumber(
    pipelineGraphId: UuidV7,
    version: number,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphVersionEntity | null>;
  loadLatestByGraphId(
    pipelineGraphId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphVersionEntity | null>;
  /** Newest first. */
  listByGraphId(
    pipelineGraphId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphVersionEntity[]>;
  /** Inserts the version row and its pinned steps. */
  insert(
    version: PipelineGraphVersionEntity,
    dbExecutor?: DbExecutor,
  ): Promise<PipelineGraphVersionEntity>;
};
