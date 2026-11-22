import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  CoreValidationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import { getProjectInputSchema } from "@scarn/core/projects/project/contracts/project-contracts";
import {
  listProjectRunsQuerySchema,
  projectRunStatusesOf,
  type ListProjectRunsQueryInput,
  type ProjectRunsPageContract,
} from "../contracts/project-runs-contracts";
import {
  hydrateProjectRuns,
  type HydrateProjectRunsDeps,
} from "./hydrate-project-runs";
import { projectRunsCounts } from "./project-runs-counts";
import type { ProjectRunsCursor } from "./project-runs-reader";

export type ListProjectRunsDeps = HydrateProjectRunsDeps & {
  userAuthz: UserAuthorizationService;
  projectRepo: Pick<ProjectRepo, "load">;
};

const invalidCursor = () =>
  new CoreValidationError(
    "The cursor is not valid",
    "INVALID_PROJECT_RUNS_CURSOR",
  );

/** `before` is opaque: `updatedAt` at microsecond precision and the row id. */
export const encodeProjectRunsCursor = (cursor: ProjectRunsCursor): string =>
  Buffer.from(`${cursor.updatedAt}|${cursor.id}`).toString("base64url");

export const decodeProjectRunsCursor = (value: string): ProjectRunsCursor => {
  const [updatedAt, id, ...rest] = Buffer.from(value, "base64url")
    .toString("utf8")
    .split("|");
  if (
    rest.length > 0 ||
    !updatedAt ||
    !id ||
    Number.isNaN(Date.parse(updatedAt))
  ) {
    throw invalidCursor();
  }
  try {
    return { updatedAt, id: parseUuidV7(id) };
  } catch {
    throw invalidCursor();
  }
};

/**
 * A project's Runs list: its pipeline runs and standalone Tasks, most
 * recently updated first, with the tab and sidebar counts for the same scope.
 * Members and public-project guests may read it; nothing waits on a guest.
 * 404 for an unknown project.
 */
export const listProjectRuns = async (
  projectIdInput: string,
  queryInput: ListProjectRunsQueryInput,
  deps: ListProjectRunsDeps,
): Promise<Result<ProjectRunsPageContract, ResourceNotFoundError>> => {
  const projectId = parseUuidV7(getProjectInputSchema.parse(projectIdInput));
  const query = listProjectRunsQuerySchema.parse(queryInput);
  const project = await deps.projectRepo.load(projectId, deps.dbExecutor);
  if (!project) {
    return Result.err(new ResourceNotFoundError("Project", projectId));
  }
  const grant = await deps.userAuthz.requireProjectPermission({
    projectId,
    permission: "executions:read",
    dbExecutor: deps.dbExecutor,
  });
  if (
    query.atNode !== undefined &&
    (query.whatRan === undefined || query.whatRan === "task")
  ) {
    throw new CoreValidationError(
      "atNode needs a pipeline definition as whatRan",
      "PROJECT_RUNS_AT_NODE_NEEDS_PIPELINE",
    );
  }
  const before = query.before
    ? decodeProjectRunsCursor(query.before)
    : undefined;
  const viewerUserId = grant.membership ? deps.userAuthz.actorId : null;
  const scope = {
    projectId,
    viewerUserId,
    actorUserId: deps.userAuthz.actorId,
    q: query.q,
    workItemId: query.workItemId,
  };
  const facets = {
    whatRan: query.whatRan,
    startedBy: query.startedBy,
    atNode: query.atNode,
  };
  const [keys, groups] = await Promise.all([
    deps.projectRunsReader.listPage(
      scope,
      {
        ...facets,
        statuses: projectRunStatusesOf(query.status),
        before,
        limit: query.limit + 1,
      },
      deps.dbExecutor,
    ),
    deps.projectRunsReader.countGroups(scope, query.atNode, deps.dbExecutor),
  ]);
  const page = keys.slice(0, query.limit);
  const last = page.at(-1);
  return Result.ok({
    runs: await hydrateProjectRuns(page, viewerUserId, deps),
    nextCursor:
      keys.length > query.limit && last
        ? encodeProjectRunsCursor({ updatedAt: last.updatedAt, id: last.id })
        : null,
    counts: projectRunsCounts(groups, facets, grant.membership !== null),
  });
};
