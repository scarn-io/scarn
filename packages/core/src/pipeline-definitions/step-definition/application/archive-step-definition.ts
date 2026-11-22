import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  getStepDefinitionInputSchema,
  type GetStepDefinitionInput,
  type StepDefinitionContract,
} from "../contracts/step-definition-contracts";
import type { StepDefinitionRepo } from "./step-definition-repo";
import {
  type StepDefinitionContractDeps,
  loadStepDefinitionContract,
} from "./load-step-definition-contracts";

export const archiveStepDefinition = async (
  input: GetStepDefinitionInput,
  {
    userAuthz,
    stepDefinitionRepo,
    taskExecutionConfigRepo,
    timeProvider,
    dbExecutor,
  }: StepDefinitionContractDeps & {
    userAuthz: UserAuthorizationService;
    stepDefinitionRepo: StepDefinitionRepo;
    timeProvider: TimeProvider;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<StepDefinitionContract, ResourceNotFoundError>> => {
  const stepDefinitionId = getStepDefinitionInputSchema.parse(input);
  const existingStepDefinition = await stepDefinitionRepo.load(
    stepDefinitionId,
    dbExecutor,
  );

  if (!existingStepDefinition) {
    return Result.err(
      new ResourceNotFoundError("Step definition", stepDefinitionId),
    );
  }

  await userAuthz.requireProjectPermission({
    projectId: existingStepDefinition.projectId,
    permission: "pipelines:write",
  });

  const archivedStepDefinition = await stepDefinitionRepo.save(
    existingStepDefinition.archive(timeProvider.now()),
    dbExecutor,
  );

  return Result.ok(
    await loadStepDefinitionContract(
      archivedStepDefinition,
      { taskExecutionConfigRepo },
      dbExecutor,
    ),
  );
};
