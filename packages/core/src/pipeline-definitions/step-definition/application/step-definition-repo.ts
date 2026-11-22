import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { StepDefinitionEntity } from "../domain/step-definition-entity";

export type StepDefinitionRepo = {
  load(
    id: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<StepDefinitionEntity | null>;
  findByKey(
    projectId: UuidV7,
    key: string,
    dbExecutor?: DbExecutor,
  ): Promise<StepDefinitionEntity | null>;
  loadMany(
    ids: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<StepDefinitionEntity[]>;
  /** The highest-numbered `active` version of each key that has one. */
  listLatestActiveByKeys(
    projectId: UuidV7,
    keys: readonly string[],
    dbExecutor?: DbExecutor,
  ): Promise<StepDefinitionEntity[]>;
  /** Latest active versions, selected before testing enabled non-local MCP auth references. */
  listLatestActiveByManagedConnectionName(
    projectId: UuidV7,
    name: string,
    dbExecutor?: DbExecutor,
  ): Promise<StepDefinitionEntity[]>;
  listByProjectId(
    projectId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<StepDefinitionEntity[]>;
  create(
    stepDefinition: StepDefinitionEntity,
    dbExecutor?: DbExecutor,
  ): Promise<StepDefinitionEntity>;
  save(
    stepDefinition: StepDefinitionEntity,
    dbExecutor?: DbExecutor,
  ): Promise<StepDefinitionEntity>;
};
