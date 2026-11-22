import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  type GetStepDefinitionInput,
  type StepDefinitionContract,
  getStepDefinitionInputSchema,
} from "../contracts/step-definition-contracts";
import type { StepDefinitionRepo } from "./step-definition-repo";
import {
  type StepDefinitionContractDeps,
  loadStepDefinitionContract,
} from "./load-step-definition-contracts";

export const getStepDefinition = async (
  input: GetStepDefinitionInput,
  {
    userAuthz,
    stepDefinitionRepo,
    taskExecutionConfigRepo,
    dbExecutor,
  }: StepDefinitionContractDeps & {
    userAuthz: UserAuthorizationService;
    stepDefinitionRepo: StepDefinitionRepo;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<StepDefinitionContract, ResourceNotFoundError>> => {
  const stepDefinitionId = getStepDefinitionInputSchema.parse(input);
  const stepDefinition = await stepDefinitionRepo.load(
    stepDefinitionId,
    dbExecutor,
  );

  if (!stepDefinition) {
    return Result.err(
      new ResourceNotFoundError("Step definition", stepDefinitionId),
    );
  }

  await userAuthz.requireProjectPermission({
    projectId: stepDefinition.projectId,
    permission: "executions:read",
  });
  return Result.ok(
    await loadStepDefinitionContract(
      stepDefinition,
      { taskExecutionConfigRepo },
      dbExecutor,
    ),
  );
};
