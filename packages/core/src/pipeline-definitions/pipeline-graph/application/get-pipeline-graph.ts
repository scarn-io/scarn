import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  type GetPipelineDefinitionInput,
  type PipelineDefinitionContract,
  getPipelineDefinitionInputSchema,
} from "../contracts/pipeline-graph-contracts";
import type { PipelineGraphRepo } from "./pipeline-graph-repo";
import { pipelineGraphEntityToContract } from "./pipeline-graph-contract-mapper";

export const getPipelineGraph = async (
  input: GetPipelineDefinitionInput,
  {
    userAuthz,
    pipelineGraphRepo,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    pipelineGraphRepo: PipelineGraphRepo;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<PipelineDefinitionContract, ResourceNotFoundError>> => {
  const id = getPipelineDefinitionInputSchema.parse(input);
  const resolved = await pipelineGraphRepo.load(id, dbExecutor);

  if (!resolved) {
    return Result.err(new ResourceNotFoundError("Pipeline graph", id));
  }

  await userAuthz.requireProjectPermission({
    projectId: resolved.handle.projectId,
    permission: "executions:read",
  });
  return Result.ok(pipelineGraphEntityToContract(resolved));
};
