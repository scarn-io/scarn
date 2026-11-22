import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  type CreateStepDefinitionInput,
  type StepDefinitionContract,
  createStepDefinitionInputSchema,
} from "../contracts/step-definition-contracts";
import { StepDefinitionEntity } from "../domain/step-definition-entity";
import type { StepDefinitionRepo } from "./step-definition-repo";
import { stepDefinitionEntityToContract } from "./step-definition-contract-mapper";
import {
  type ResolveStepDefinitionTaskExecutionConfigDeps,
  resolveStepDefinitionTaskExecutionConfig,
} from "./resolve-step-definition-task-execution-config";

export const createStepDefinition = async (
  input: CreateStepDefinitionInput,
  {
    userAuthz,
    stepDefinitionRepo,
    taskExecutionConfigRepo,
    environmentRepo,
    timeProvider,
    dbExecutor,
  }: ResolveStepDefinitionTaskExecutionConfigDeps & {
    timeProvider: TimeProvider;
    userAuthz?: UserAuthorizationService;
    stepDefinitionRepo: StepDefinitionRepo;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<StepDefinitionContract> => {
  const parsedInput = createStepDefinitionInputSchema.parse(input);
  if (userAuthz) {
    await userAuthz.requireProjectPermission({
      projectId: parsedInput.projectId,
      permission: "pipelines:write",
    });
  }

  const run = async (tx: DbExecutor) => {
    const now = timeProvider.now();
    const config = await resolveStepDefinitionTaskExecutionConfig(
      parsedInput,
      { taskExecutionConfigRepo, environmentRepo },
      tx,
    );
    const stepDefinition = StepDefinitionEntity.create({
      projectId: parsedInput.projectId,
      key: parsedInput.key,
      name: parsedInput.name,
      description: parsedInput.description,
      prompt: parsedInput.prompt,
      version: parsedInput.version,
      kind: parsedInput.kind,
      entrypointJson: parsedInput.entrypointJson,
      toolCallJson: parsedInput.toolCallJson,
      inputSchemaJson: parsedInput.inputSchemaJson,
      resultSchemaJson: parsedInput.resultSchemaJson,
      errors: parsedInput.errors,
      retry: parsedInput.retry,
      grants: parsedInput.grants,
      maxTurns: parsedInput.maxTurns,
      concurrency: parsedInput.concurrency,
      taskExecutionConfigId: config?.id ?? null,
      status: parsedInput.status,
      createdAt: now,
      updatedAt: now,
    });
    const createdStepDefinition = await stepDefinitionRepo.create(
      stepDefinition,
      tx,
    );

    return stepDefinitionEntityToContract(createdStepDefinition, config);
  };

  if (dbExecutor) {
    return await run(dbExecutor);
  }
  return await getDb().transaction(async (tx) => await run(tx));
};
