import { resolveRepoConfig } from "@scarn/core/common/contracts/repo-config";
import type { TaskExecutionConfigEntity } from "@scarn/core/tasks/task-execution-config/domain/task-execution-config-entity";
import { environmentRefFromStored } from "@scarn/core/tasks/task-execution-config/domain/task-execution-config-runtime";
import type { StepDefinitionContract } from "../contracts/step-definition-contracts";
import type { StepDefinitionEntity } from "../domain/step-definition-entity";

const toIsoString = (value: Date | null | undefined) =>
  value?.toISOString() ?? null;

/**
 * The step definition's environment and independent overrides read back from its
 * task execution config. A `null` config, and every `null` field of one,
 * means the repo's own config applies: the default devcontainer, the
 * runtime's default repo mode, and nothing declared.
 */
export const inlineConfigFieldsFromTaskExecutionConfig = (
  config: TaskExecutionConfigEntity | null,
) => {
  return {
    environment: environmentRefFromStored(config?.environment ?? null),
    repo: config?.git ?? resolveRepoConfig(),
    opencodeMcpJson: config?.mcp ?? null,
    healthChecksJson: config?.healthChecks ?? null,
  };
};

/**
 * Builds the wire shape (D17), reading the environment and overrides back
 * from the step definition's task execution config.
 */
export const stepDefinitionEntityToContract = (
  stepDefinition: StepDefinitionEntity,
  config: TaskExecutionConfigEntity | null,
): StepDefinitionContract => {
  const inline = inlineConfigFieldsFromTaskExecutionConfig(config);
  return {
    id: stepDefinition.id,
    projectId: stepDefinition.projectId,
    key: stepDefinition.key,
    name: stepDefinition.name,
    description: stepDefinition.description,
    prompt: stepDefinition.prompt,
    version: stepDefinition.version,
    kind: stepDefinition.kind,
    entrypointJson: stepDefinition.entrypointJson,
    toolCallJson: stepDefinition.toolCallJson,
    environment: inline.environment,
    inputSchemaJson: stepDefinition.inputSchemaJson,
    resultSchemaJson: stepDefinition.resultSchemaJson,
    errors: [...stepDefinition.errors],
    retry: stepDefinition.retry.map((entry) => ({
      on: [...entry.on],
      maxAttempts: entry.maxAttempts,
    })),
    grants: [...stepDefinition.grants],
    maxTurns: stepDefinition.maxTurns,
    concurrency: stepDefinition.concurrency,
    logs: { archive: stepDefinition.logArchive },
    opencodeMcpJson: inline.opencodeMcpJson,
    healthChecksJson: inline.healthChecksJson,
    repo: inline.repo,
    status: stepDefinition.status,
    createdAt:
      toIsoString(stepDefinition.createdAt) ?? new Date(0).toISOString(),
    updatedAt:
      toIsoString(stepDefinition.updatedAt) ?? new Date(0).toISOString(),
  };
};
