import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { sendVisitMessage } from "@scarn/core/pipeline-executions/pipeline-run/application/send-visit-message";
import { decideWaitVisit } from "@scarn/core/pipeline-executions/pipeline-run/application/decide-wait-visit";
import {
  decideWaitVisitInputSchema,
  getPipelineExecutionInputSchema,
  pipelineExecutionSchema,
  sendVisitMessageResultSchema,
} from "@scarn/core/pipeline-executions/pipeline-run/contracts/pipeline-run-contracts";
import { sendStepMessageBodySchema } from "@scarn/core/tasks/task-message/contracts/task-message-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { responseSchemas } from "../response-schemas";

/**
 * Visit-keyed commands a user sends to one node visit of a run: steering a
 * step visit with a message, and deciding a decision wait.
 */
const visitParamsSchema = z.object({
  pipelineExecutionId: getPipelineExecutionInputSchema,
  visitId: getPipelineExecutionInputSchema,
});
const decideWaitVisitBodySchema = decideWaitVisitInputSchema.omit({
  pipelineExecutionId: true,
  visitId: true,
});

const errorResponses = {
  401: apiErrorResponseSchema,
  403: apiErrorResponseSchema,
  404: apiErrorResponseSchema,
  409: apiErrorResponseSchema,
  422: apiErrorResponseSchema,
  500: apiErrorResponseSchema,
};

export const createPipelineExecutionStepMessageRoutes = (
  appContext: AppContext,
) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/pipeline-executions/:pipelineExecutionId/visits/:visitId/messages",
      {
        params: visitParamsSchema,
        body: sendStepMessageBodySchema,
        response: responseSchemas({
          200: sendVisitMessageResultSchema,
          ...errorResponses,
        }),
        detail: {
          operationId: "sendVisitMessage",
          description:
            "Sends a message to a step visit of a pipeline execution. Requires `executions:write`. Reruns the visit; its new Task carries the message. Code and MCP tool steps don't accept messages.",
          tags: ["PipelineExecutions"],
        },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await sendVisitMessage(
            {
              ...visitParamsSchema.parse(params),
              ...sendStepMessageBodySchema.parse(body),
            },
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        ),
    )
    .post(
      "/pipeline-executions/:pipelineExecutionId/visits/:visitId/decision",
      {
        params: visitParamsSchema,
        body: decideWaitVisitBodySchema,
        response: responseSchemas({
          200: pipelineExecutionSchema,
          ...errorResponses,
        }),
        detail: {
          operationId: "decideWaitVisit",
          description:
            "Records a decision on a waiting decision visit. Requires `executions:write`.",
          tags: ["PipelineExecutions"],
        },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await decideWaitVisit(
            {
              ...visitParamsSchema.parse(params),
              ...decideWaitVisitBodySchema.parse(body),
            },
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        ),
    );
