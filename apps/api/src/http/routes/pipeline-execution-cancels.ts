import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { cancelPipelineExecutions } from "@scarn/core/pipeline-executions/pipeline-run/application/cancel-pipeline-run";
import {
  cancelPipelineExecutionsInputSchema,
  cancelPipelineExecutionsResultSchema,
} from "@scarn/core/pipeline-executions/pipeline-run/contracts/pipeline-run-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { responseSchemas } from "../response-schemas";

/**
 * The batch-cancel sibling of `/pipeline-executions/:pipelineExecutionId/cancel`.
 */
const cancelPipelineExecutionsBodySchema = z.object({
  input: cancelPipelineExecutionsInputSchema,
});

export const createPipelineExecutionCancelRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .put(
      "/pipeline-executions/batch/cancel",
      {
        body: cancelPipelineExecutionsBodySchema,
        response: responseSchemas({
          200: cancelPipelineExecutionsResultSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "cancelPipelineExecutions",
          description:
            "Batch-cancels pipeline executions. Requires `executions:write` on each execution's project. Executions in the batch that are not in a cancelable state (already finished, cancelled, etc.) are skipped rather than cancelled, and are reported in `skippedIds` alongside the `cancelledIds` that were actually cancelled.",
          tags: ["PipelineExecutions"],
        },
      },
      async ({ body, auth }) =>
        Result.unwrap(
          await cancelPipelineExecutions(
            cancelPipelineExecutionsBodySchema.parse(body).input,
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        ),
    );
