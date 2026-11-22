import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  CoreValidationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  pipelineVersionRefInputSchema,
  type PipelineDefinitionContract,
  type PipelineVersionRefInput,
} from "../contracts/pipeline-graph-contracts";
import type { PipelineGraphRepo } from "./pipeline-graph-repo";
import type { PipelineGraphVersionRepo } from "./pipeline-graph-version-repo";
import { pipelineGraphEntityToContract } from "./pipeline-graph-contract-mapper";

/**
 * Points the pipeline's active version at an already-published version, e.g.
 * to roll back. New runs start on it; running runs keep their own version.
 */
export const activatePipelineGraphVersion = async (
  input: PipelineVersionRefInput,
  {
    userAuthz,
    pipelineGraphRepo,
    pipelineGraphVersionRepo,
    timeProvider,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    pipelineGraphRepo: PipelineGraphRepo;
    pipelineGraphVersionRepo: PipelineGraphVersionRepo;
    timeProvider: TimeProvider;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<
  Result<
    PipelineDefinitionContract,
    ResourceNotFoundError | CoreValidationError
  >
> => {
  const parsed = pipelineVersionRefInputSchema.parse(input);
  const pipelineGraphId = parsed.pipelineDefinitionId;
  const run = async (tx: DbExecutor) => {
    const handle = await pipelineGraphRepo.lockHandle(pipelineGraphId, tx);
    if (!handle) {
      return Result.err(
        new ResourceNotFoundError("Pipeline graph", pipelineGraphId),
      );
    }
    await userAuthz.requireProjectPermission({
      projectId: handle.projectId,
      permission: "pipelines:write",
    });
    if (handle.isArchived) {
      return Result.err(
        new CoreValidationError(
          "An archived pipeline can't be activated",
          "PIPELINE_GRAPH_ARCHIVED",
        ),
      );
    }
    const version = await pipelineGraphVersionRepo.loadByNumber(
      handle.id,
      parsed.version,
      tx,
    );
    if (!version) {
      return Result.err(
        new ResourceNotFoundError(
          "Pipeline graph version",
          `${handle.key}@${String(parsed.version)}`,
        ),
      );
    }
    const updated =
      handle.currentVersionId === version.id
        ? handle
        : await pipelineGraphRepo.updateHandle(
            handle.withCurrentVersionId(version.id, timeProvider.now()),
            tx,
          );
    return Result.ok(
      pipelineGraphEntityToContract({
        handle: updated,
        currentVersion: version,
      }),
    );
  };
  return dbExecutor
    ? await dbExecutor.transaction(run)
    : await getDb().transaction(run);
};
