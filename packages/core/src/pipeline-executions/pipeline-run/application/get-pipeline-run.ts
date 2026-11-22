import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  getPipelineExecutionInputSchema,
  type GetPipelineExecutionInput,
  type PipelineExecutionContract,
} from "../contracts/pipeline-run-contracts";
import {
  projectPipelineRunsToContracts,
  type PipelineRunReadDeps,
} from "./pipeline-run-contract-mapper";

/** A run with its visits, lane groups and lanes. */
export const getPipelineRun = async (
  input: GetPipelineExecutionInput,
  deps: PipelineRunReadDeps & { userAuthz: UserAuthorizationService },
): Promise<Result<PipelineExecutionContract, ResourceNotFoundError>> => {
  const id = getPipelineExecutionInputSchema.parse(input);
  const run = await deps.pipelineRunRepo.load(id, deps.dbExecutor);
  if (!run) {
    return Result.err(new ResourceNotFoundError("Pipeline run", id));
  }
  await deps.userAuthz.requireProjectPermission({
    projectId: run.projectId,
    permission: "executions:read",
    dbExecutor: deps.dbExecutor,
  });
  const [contract] = await projectPipelineRunsToContracts([run], deps);
  return contract
    ? Result.ok(contract)
    : Result.err(new ResourceNotFoundError("Pipeline run", id));
};
