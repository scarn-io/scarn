import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { getPipelineRun as getPipelineExecution } from "@scarn/core/pipeline-executions/pipeline-run/application/get-pipeline-run";
import { getVisitThread } from "@scarn/core/pipeline-executions/pipeline-run/application/get-visit-thread";
import { listWorkItemQuestions } from "@scarn/core/pipeline-executions/pipeline-run/application/list-work-item-questions";
import { listPipelineRunsByProjectId as listPipelineExecutionsByProjectId } from "@scarn/core/pipeline-executions/pipeline-run/application/list-pipeline-runs";
import {
  getPipelineExecutionInputSchema,
  listWorkItemQuestionsInputSchema,
  pipelineExecutionSchema,
  paginatedPipelineExecutionSummariesSchema,
  visitThreadSchema,
  workItemQuestionSchema,
} from "@scarn/core/pipeline-executions/pipeline-run/contracts/pipeline-run-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createOptionallyAuthenticated } from "./authenticated";
import {
  listPipelineExecutionsRouteQuerySchema,
  toListPipelineExecutionsQuery,
} from "./pipeline-executions-query";
import { responseSchemas } from "../response-schemas";

/**
 * The read side of `/pipeline-executions`, plus the pipeline side of a work
 * item's comments (`/work-items/:workItemId/questions`).
 *
 * Uses `createOptionallyAuthenticated` rather than `createAuthenticated`: this
 * seam is also what lets non-members of a public project — including fully
 * anonymous callers — read execution details without a session (issue #149).
 * Each use case's `requireProjectPermission` call still enforces the real
 * check; a missing/non-member session on a private project is denied exactly
 * as before (401/403).
 */
const pipelineExecutionIdParamsSchema = z.object({
  pipelineExecutionId: getPipelineExecutionInputSchema,
});

const workItemIdParamsSchema = z.object({
  workItemId: listWorkItemQuestionsInputSchema,
});

const visitThreadParamsSchema = pipelineExecutionIdParamsSchema.extend({
  visitId: getPipelineExecutionInputSchema,
});

export const createPipelineExecutionReadRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(
      createOptionallyAuthenticated(appContext.createUserAuthorizationService),
    )
    .get(
      "/pipeline-executions/:pipelineExecutionId",
      {
        params: pipelineExecutionIdParamsSchema,
        response: responseSchemas({
          200: pipelineExecutionSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "getPipelineExecution",
          tags: ["PipelineExecutions"],
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await getPipelineExecution(
            pipelineExecutionIdParamsSchema.parse(params).pipelineExecutionId,
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        ),
    )
    .get(
      "/pipeline-executions/:pipelineExecutionId/visits/:visitId/thread",
      {
        params: visitThreadParamsSchema,
        response: responseSchemas({
          200: visitThreadSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "getVisitThread",
          description:
            "A visit's conversation: its latest Task and every earlier run it continues, oldest first, with the messages sent to each. Requires `executions:read`.",
          tags: ["PipelineExecutions"],
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await getVisitThread(visitThreadParamsSchema.parse(params), {
            ...appContext,
            userAuthz: auth.userAuthz,
          }),
        ),
    )
    // The list serves a page of the summary contract; the detail route above
    // keeps the full tree. See `pipelineExecutionSummarySchema`.
    .get(
      "/pipeline-executions",
      {
        query: listPipelineExecutionsRouteQuerySchema,
        response: responseSchemas({
          200: paginatedPipelineExecutionSummariesSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "listPipelineExecutions",
          tags: ["PipelineExecutions"],
        },
      },
      async ({ query, auth }) =>
        await listPipelineExecutionsByProjectId(
          toListPipelineExecutionsQuery(
            listPipelineExecutionsRouteQuerySchema.parse(query),
          ),
          { ...appContext, userAuthz: auth.userAuthz },
        ),
    )
    .get(
      "/work-items/:workItemId/questions",
      {
        params: workItemIdParamsSchema,
        response: responseSchemas({
          200: z.array(workItemQuestionSchema),
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "listWorkItemQuestions",
          description:
            "The question comments runs posted on a work item, oldest first, each with the run and visit that asked it and its status (`open`, `answered` or `not_needed`). The comments UI reads it so the comments API needn't know about runs. Requires `comments:read`.",
          tags: ["WorkItems"],
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await listWorkItemQuestions(
            workItemIdParamsSchema.parse(params).workItemId,
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        ),
    );
