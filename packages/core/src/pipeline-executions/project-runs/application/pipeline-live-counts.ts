import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import { getProjectInputSchema } from "@scarn/core/projects/project/contracts/project-contracts";
import type { PipelineLiveCountsContract } from "../contracts/project-runs-contracts";
import type { ProjectRunsReader } from "./project-runs-reader";

export type PipelineLiveCountsDeps = {
  userAuthz: UserAuthorizationService;
  projectRepo: Pick<ProjectRepo, "load">;
  projectRunsReader: Pick<ProjectRunsReader, "pipelineLiveCounts">;
  dbExecutor?: DbExecutor;
  now?: () => Date;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Live counts for a project's pipeline cards: per pipeline definition, its
 * in-progress runs and the runs that succeeded in the last 7 days, and per
 * node the open visits (running, waiting, fan-out lanes) and the uncaught
 * failures. Same access as the Runs list. 404 for an unknown project.
 */
export const pipelineLiveCounts = async (
  projectIdInput: string,
  deps: PipelineLiveCountsDeps,
): Promise<Result<PipelineLiveCountsContract, ResourceNotFoundError>> => {
  const projectId = parseUuidV7(getProjectInputSchema.parse(projectIdInput));
  const project = await deps.projectRepo.load(projectId, deps.dbExecutor);
  if (!project) {
    return Result.err(new ResourceNotFoundError("Project", projectId));
  }
  await deps.userAuthz.requireProjectPermission({
    projectId,
    permission: "executions:read",
    dbExecutor: deps.dbExecutor,
  });
  const since = new Date((deps.now?.() ?? new Date()).getTime() - WEEK_MS);
  const { pipelines, nodes } = await deps.projectRunsReader.pipelineLiveCounts(
    projectId,
    since,
    deps.dbExecutor,
  );
  const nodesByPipeline = new Map<
    string,
    PipelineLiveCountsContract["pipelines"][number]["nodes"]
  >();
  for (const { pipelineDefinitionId, nodeId, ...counts } of nodes) {
    const entry = nodesByPipeline.get(pipelineDefinitionId) ?? {};
    entry[nodeId] = counts;
    nodesByPipeline.set(pipelineDefinitionId, entry);
  }
  return Result.ok({
    pipelines: pipelines.map((pipeline) => ({
      ...pipeline,
      nodes: nodesByPipeline.get(pipeline.pipelineDefinitionId) ?? {},
    })),
  });
};
