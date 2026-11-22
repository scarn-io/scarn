import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  type ListStepDefinitionsByProjectIdInput,
  type StepDefinitionContract,
  listStepDefinitionsByProjectIdInputSchema,
} from "../contracts/step-definition-contracts";
import type { StepDefinitionRepo } from "./step-definition-repo";
import {
  type StepDefinitionContractDeps,
  loadStepDefinitionContracts,
} from "./load-step-definition-contracts";

export const listStepDefinitionsByProjectId = async (
  input: ListStepDefinitionsByProjectIdInput,
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
): Promise<StepDefinitionContract[]> => {
  const projectId = listStepDefinitionsByProjectIdInputSchema.parse(input);
  await userAuthz.requireProjectPermission({
    projectId,
    permission: "executions:read",
  });
  const stepDefinitions = await stepDefinitionRepo.listByProjectId(
    projectId,
    dbExecutor,
  );

  return await loadStepDefinitionContracts(
    stepDefinitions,
    { taskExecutionConfigRepo },
    dbExecutor,
  );
};
