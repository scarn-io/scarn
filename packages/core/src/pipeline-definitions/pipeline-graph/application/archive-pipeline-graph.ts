import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  type GetPipelineDefinitionInput,
  type PipelineDefinitionContract,
  getPipelineDefinitionInputSchema,
} from "../contracts/pipeline-graph-contracts";
import type { PipelineGraphRepo } from "./pipeline-graph-repo";
import { pipelineGraphEntityToContract } from "./pipeline-graph-contract-mapper";

export const archivePipelineGraph = async (
  input: GetPipelineDefinitionInput,
  {
    userAuthz,
    pipelineGraphRepo,
    timeProvider,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    pipelineGraphRepo: PipelineGraphRepo;
    timeProvider: TimeProvider;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<PipelineDefinitionContract, ResourceNotFoundError>> => {
  const id = getPipelineDefinitionInputSchema.parse(input);
  const existing = await pipelineGraphRepo.load(id, dbExecutor);
  if (!existing) {
    return Result.err(new ResourceNotFoundError("Pipeline graph", id));
  }
  await userAuthz.requireProjectPermission({
    projectId: existing.handle.projectId,
    permission: "pipelines:write",
  });

  const archivedHandle = await pipelineGraphRepo.updateHandle(
    existing.handle.archive(timeProvider.now()),
    dbExecutor,
  );

  return Result.ok(
    pipelineGraphEntityToContract({
      handle: archivedHandle,
      currentVersion: existing.currentVersion,
    }),
  );
};
