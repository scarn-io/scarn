import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  listPipelineExecutionsQuerySchema,
  type ListPipelineExecutionsQueryInput,
  type PaginatedPipelineExecutionSummariesContract,
} from "../contracts/pipeline-run-contracts";
import {
  loadProjectedRuns,
  projectedRunToSummary,
  type PipelineRunReadDeps,
} from "./pipeline-run-contract-mapper";

/**
 * A page of a project's runs. Filtering by display status needs each run's
 * open visits and Tasks, so the matching runs are projected in memory and
 * paginated after; a dedicated summary query can replace this once volume
 * calls for it.
 */
export const listPipelineRunsByProjectId = async (
  queryInput: ListPipelineExecutionsQueryInput,
  deps: PipelineRunReadDeps & { userAuthz: UserAuthorizationService },
): Promise<PaginatedPipelineExecutionSummariesContract> => {
  const query = listPipelineExecutionsQuerySchema.parse(queryInput);
  await deps.userAuthz.requireProjectPermission({
    projectId: query.projectId,
    permission: "executions:read",
    dbExecutor: deps.dbExecutor,
  });

  const runs = (
    await deps.pipelineRunRepo.listByProjectId(query.projectId, deps.dbExecutor)
  ).filter(
    (run) =>
      (!query.pipelineId || run.pipelineGraphId === query.pipelineId) &&
      (!query.workItemId || run.workItemId === query.workItemId),
  );
  const summaries = (await loadProjectedRuns(runs, deps))
    .map(projectedRunToSummary)
    .filter((summary) => !query.status || summary.status === query.status);

  const direction = query.sort === "oldest" ? 1 : -1;
  summaries.sort((left, right) => {
    const byTime = left.createdAt.localeCompare(right.createdAt);
    return (
      direction * (byTime !== 0 ? byTime : left.id.localeCompare(right.id))
    );
  });

  const start = (query.page - 1) * query.pageSize;
  return {
    items: summaries.slice(start, start + query.pageSize),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total: summaries.length,
    },
  };
};
