/** Browser fetchers for the project's Runs list and its single rows. */
import type {
  ProjectRunLookupKind,
  ProjectRunsPageContract,
} from "@scarn/core/pipeline-executions/project-runs/contracts/project-runs-contracts";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";
import type { RunsQuery } from "./runs-params";

export type RunsPage = ProjectRunsPageContract;
export type ProjectRun = RunsPage["runs"][number];
export type RunsCounts = RunsPage["counts"];

export const RUNS_POLL_MS = 15_000;
export const RUNS_PAGE_SIZE = 50;

const isUuidFilter = (value: string) => value !== "task";

export async function fetchProjectRuns(
  projectId: string,
  query: RunsQuery,
  options: { before?: string; limit?: number } = {},
): Promise<RunsPage> {
  const apiClient = getBrowserScarnApiClient();
  const { whatRan, startedBy, workItemId, atNode, q } = query;
  return await unwrapTreatyResponse(
    apiClient.api.projects({ projectId: parseUuidV7(projectId) }).runs.get({
      query: {
        status: query.status,
        limit: options.limit ?? RUNS_PAGE_SIZE,
        ...(whatRan !== undefined
          ? {
              whatRan: isUuidFilter(whatRan)
                ? parseUuidV7(whatRan)
                : (whatRan as "task"),
            }
          : {}),
        ...(startedBy !== undefined
          ? {
              startedBy:
                startedBy === "me" ? ("me" as const) : parseUuidV7(startedBy),
            }
          : {}),
        ...(workItemId !== undefined
          ? { workItemId: parseUuidV7(workItemId) }
          : {}),
        ...(atNode !== undefined ? { atNode } : {}),
        ...(q !== undefined ? { q } : {}),
        ...(options.before !== undefined ? { before: options.before } : {}),
      },
    }),
  );
}

/** How a run's page looks it up: a step row is reached as a `task`. */
export type ProjectRunLookup = { type: ProjectRunLookupKind; id: string };

/** One row of the Runs list, derived as the list derives it. */
export async function fetchProjectRun(
  projectId: string,
  lookup: ProjectRunLookup,
): Promise<ProjectRun> {
  const apiClient = getBrowserScarnApiClient();
  return await unwrapTreatyResponse(
    apiClient.api
      .projects({ projectId: parseUuidV7(projectId) })
      .runs({ type: lookup.type })({ id: parseUuidV7(lookup.id) })
      .get(),
  );
}
