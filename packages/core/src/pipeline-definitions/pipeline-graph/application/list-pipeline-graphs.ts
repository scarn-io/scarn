import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  type PipelineDefinitionContract,
  type ListPipelineDefinitionsByProjectIdInput,
  listPipelineDefinitionsByProjectIdInputSchema,
} from "../contracts/pipeline-graph-contracts";
import type { PipelineGraphRepo } from "./pipeline-graph-repo";
import { pipelineGraphEntityToContract } from "./pipeline-graph-contract-mapper";

export const listPipelineGraphsByProjectId = async (
  input: ListPipelineDefinitionsByProjectIdInput,
  {
    userAuthz,
    pipelineGraphRepo,
    includeArchived,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    pipelineGraphRepo: PipelineGraphRepo;
    includeArchived?: boolean | undefined;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<PipelineDefinitionContract[]> => {
  const projectId = listPipelineDefinitionsByProjectIdInputSchema.parse(input);
  await userAuthz.requireProjectPermission({
    projectId,
    permission: "executions:read",
  });
  const resolved = await pipelineGraphRepo.listByProjectId(
    projectId,
    { includeArchived: includeArchived ?? false },
    dbExecutor,
  );

  return resolved.map(pipelineGraphEntityToContract);
};
