import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { PersistenceError } from "@scarn/core/lib/errors";
import type { TaskExecutionConfigRepo } from "@scarn/core/tasks/task-execution-config/application/task-execution-config-repo";
import type { StepDefinitionContract } from "../contracts/step-definition-contracts";
import type { StepDefinitionEntity } from "../domain/step-definition-entity";
import { stepDefinitionEntityToContract } from "./step-definition-contract-mapper";

export type StepDefinitionContractDeps = {
  taskExecutionConfigRepo: TaskExecutionConfigRepo;
};

/**
 * Maps step definitions to contracts, loading their task execution configs
 * in one batch. A step definition without a config runs on the repo's own
 * config.
 */
export const loadStepDefinitionContracts = async (
  stepDefinitions: readonly StepDefinitionEntity[],
  { taskExecutionConfigRepo }: StepDefinitionContractDeps,
  dbExecutor?: DbExecutor,
): Promise<StepDefinitionContract[]> => {
  if (stepDefinitions.length === 0) {
    return [];
  }

  const configIds = [
    ...new Set(
      stepDefinitions.flatMap((item) =>
        item.taskExecutionConfigId === null ? [] : [item.taskExecutionConfigId],
      ),
    ),
  ];
  const configs = await taskExecutionConfigRepo.loadMany(configIds, dbExecutor);
  const configById = new Map<UuidV7, (typeof configs)[number]>(
    configs.map((item) => [item.id, item]),
  );

  return stepDefinitions.map((stepDefinition) => {
    const configId = stepDefinition.taskExecutionConfigId;
    if (configId === null) {
      return stepDefinitionEntityToContract(stepDefinition, null);
    }
    const config = configById.get(configId);
    if (!config) {
      throw new PersistenceError(
        `Step definition ${stepDefinition.id} references a missing task execution config ${configId}`,
        "STEP_DEFINITION_TASK_EXECUTION_CONFIG_MISSING",
      );
    }
    return stepDefinitionEntityToContract(stepDefinition, config);
  });
};

export const loadStepDefinitionContract = async (
  stepDefinition: StepDefinitionEntity,
  deps: StepDefinitionContractDeps,
  dbExecutor?: DbExecutor,
): Promise<StepDefinitionContract> => {
  const [contract] = await loadStepDefinitionContracts(
    [stepDefinition],
    deps,
    dbExecutor,
  );
  if (!contract) {
    throw new PersistenceError(
      `Failed to map step definition ${stepDefinition.id}`,
      "STEP_DEFINITION_CONTRACT_MAPPING_FAILED",
    );
  }
  return contract;
};
