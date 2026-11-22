import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { getProjectRun } from "@scarn/core/pipeline-executions/project-runs/application/get-project-run";
import { listProjectRuns } from "@scarn/core/pipeline-executions/project-runs/application/list-project-runs";
import { pipelineLiveCounts } from "@scarn/core/pipeline-executions/project-runs/application/pipeline-live-counts";
import {
  getProjectRunParamsSchema,
  listProjectRunsQuerySchema,
  pipelineLiveCountsSchema,
  projectRunSchema,
  projectRunsPageSchema,
} from "@scarn/core/pipeline-executions/project-runs/contracts/project-runs-contracts";
import { getProjectInputSchema } from "@scarn/core/projects/project/contracts/project-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createOptionallyAuthenticated } from "./authenticated";
import { stdErrors } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

/** The project's Runs list and its single rows; read-only, so it also serves guests of a public project. */
export const createProjectRunsRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(
      createOptionallyAuthenticated(appContext.createUserAuthorizationService),
    )
    .get(
      "/projects/:projectId/runs",
      {
        params: z.object({ projectId: getProjectInputSchema }),
        query: listProjectRunsQuerySchema,
        response: responseSchemas({
          200: projectRunsPageSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "listProjectRuns",
          description:
            "Lists a project's runs (pipeline runs, standalone Tasks and chats), most recently updated first, with tab and facet counts. Responds 422 `INVALID_PROJECT_RUNS_CURSOR` for a malformed `before` and 422 `PROJECT_RUNS_AT_NODE_NEEDS_PIPELINE` when `atNode` is given without a pipeline `whatRan`.",
          tags: ["PipelineExecutions"],
        },
      },
      async ({ params: { projectId }, query, auth }) =>
        Result.unwrap(
          await listProjectRuns(projectId, query, {
            ...appContext,
            userAuthz: auth.userAuthz,
          }),
        ),
    )
    .get(
      "/projects/:projectId/runs/:type/:id",
      {
        params: getProjectRunParamsSchema,
        response: responseSchemas({
          200: projectRunSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "getProjectRun",
          description:
            "Reads one row of a project's Runs list, derived as the list derives it. `type` is `pipeline`, `task` (a single step or prompt Task) or `chat` (by conversation id). Responds 404 when the id is not a row of that kind, including a Task run by a pipeline's node visit.",
          tags: ["PipelineExecutions"],
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await getProjectRun(params, {
            ...appContext,
            userAuthz: auth.userAuthz,
          }),
        ),
    )
    .get(
      "/projects/:projectId/pipeline-definitions/live-counts",
      {
        params: z.object({ projectId: getProjectInputSchema }),
        response: responseSchemas({
          200: pipelineLiveCountsSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "getPipelineLiveCounts",
          description:
            "Live run counts for each of a project's pipeline definitions: runs in progress, runs that succeeded in the last 7 days, and per node the open visits (running, waiting, fan-out lanes) and uncaught failures of in-progress runs or of runs that crashed in the last 7 days.",
          tags: ["PipelineExecutions"],
        },
      },
      async ({ params: { projectId }, auth }) =>
        Result.unwrap(
          await pipelineLiveCounts(projectId, {
            ...appContext,
            userAuthz: auth.userAuthz,
          }),
        ),
    );
