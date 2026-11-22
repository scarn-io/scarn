import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  getPipelineDefinitionInputSchema,
  pipelineVersionRefInputSchema,
  type GetPipelineDefinitionInput,
  type PipelineVersionContract,
  type PipelineVersionRefInput,
  type PipelineVersionSummaryContract,
} from "../contracts/pipeline-graph-contracts";
import type { PipelineGraphRepo } from "./pipeline-graph-repo";
import type { PipelineGraphVersionRepo } from "./pipeline-graph-version-repo";
import {
  pipelineGraphVersionEntityToContract,
  pipelineGraphVersionEntityToSummary,
} from "./pipeline-graph-contract-mapper";

type ReadDeps = {
  userAuthz: UserAuthorizationService;
  pipelineGraphRepo: PipelineGraphRepo;
  pipelineGraphVersionRepo: PipelineGraphVersionRepo;
  dbExecutor?: DbExecutor | undefined;
};

/** One published version by number, with its document and pinned steps. */
export const getPipelineGraphVersion = async (
  input: PipelineVersionRefInput,
  {
    userAuthz,
    pipelineGraphRepo,
    pipelineGraphVersionRepo,
    dbExecutor,
  }: ReadDeps,
): Promise<Result<PipelineVersionContract, ResourceNotFoundError>> => {
  const parsed = pipelineVersionRefInputSchema.parse(input);
  const pipelineGraphId = parsed.pipelineDefinitionId;
  const handle = await pipelineGraphRepo.loadHandle(
    pipelineGraphId,
    dbExecutor,
  );
  if (!handle) {
    return Result.err(
      new ResourceNotFoundError("Pipeline graph", pipelineGraphId),
    );
  }
  await userAuthz.requireProjectPermission({
    projectId: handle.projectId,
    permission: "executions:read",
  });
  const version = await pipelineGraphVersionRepo.loadByNumber(
    handle.id,
    parsed.version,
    dbExecutor,
  );
  if (!version) {
    return Result.err(
      new ResourceNotFoundError(
        "Pipeline graph version",
        `${handle.key}@${String(parsed.version)}`,
      ),
    );
  }
  return Result.ok(pipelineGraphVersionEntityToContract(version));
};

/** Every published version of a pipeline, newest first, without documents. */
export const listPipelineGraphVersions = async (
  input: GetPipelineDefinitionInput,
  {
    userAuthz,
    pipelineGraphRepo,
    pipelineGraphVersionRepo,
    dbExecutor,
  }: ReadDeps,
): Promise<Result<PipelineVersionSummaryContract[], ResourceNotFoundError>> => {
  const pipelineGraphId = getPipelineDefinitionInputSchema.parse(input);
  const handle = await pipelineGraphRepo.loadHandle(
    pipelineGraphId,
    dbExecutor,
  );
  if (!handle) {
    return Result.err(
      new ResourceNotFoundError("Pipeline graph", pipelineGraphId),
    );
  }
  await userAuthz.requireProjectPermission({
    projectId: handle.projectId,
    permission: "executions:read",
  });
  const versions = await pipelineGraphVersionRepo.listByGraphId(
    handle.id,
    dbExecutor,
  );
  return Result.ok(versions.map(pipelineGraphVersionEntityToSummary));
};
