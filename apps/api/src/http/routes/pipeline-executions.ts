import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { createPipelineRun as createPipelineExecution } from "@scarn/core/pipeline-executions/pipeline-run/application/create-pipeline-run";
import { rerunVisit } from "@scarn/core/pipeline-executions/pipeline-run/application/rerun-visit";
import { overruleVisitRoute } from "@scarn/core/pipeline-executions/pipeline-run/application/overrule-visit-route";
import {
  overrulePreviewResultSchema,
  overruleVisitRouteBodySchema,
} from "@scarn/core/pipeline-executions/pipeline-run/contracts/overrule-contracts";
import { cancelPipelineRun as cancelPipelineExecution } from "@scarn/core/pipeline-executions/pipeline-run/application/cancel-pipeline-run";
import { answerQuestionAndAdvance } from "@scarn/core/pipeline-executions/pipeline-run/application/comment-and-advance";
import { workItemCommentSchema } from "@scarn/core/work-items/work-item-comment/contracts/work-item-comment-contracts";
import { continueWithoutReply } from "@scarn/core/pipeline-executions/pipeline-run/application/continue-without-reply";
import {
  answerQuestionBodySchema,
  continueWithoutReplyInputSchema,
  createPipelineExecutionInputSchema,
  getPipelineExecutionInputSchema,
  pipelineExecutionSchema,
} from "@scarn/core/pipeline-executions/pipeline-run/contracts/pipeline-run-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { responseSchemas } from "../response-schemas";

const pipelineExecutionIdParamsSchema = z.object({
  pipelineExecutionId: getPipelineExecutionInputSchema,
});
const visitParamsSchema = pipelineExecutionIdParamsSchema.extend({
  visitId: getPipelineExecutionInputSchema,
});

const commandResponses = {
  200: pipelineExecutionSchema,
  401: apiErrorResponseSchema,
  403: apiErrorResponseSchema,
  404: apiErrorResponseSchema,
  409: apiErrorResponseSchema,
  422: apiErrorResponseSchema,
  500: apiErrorResponseSchema,
};

export const createPipelineExecutionRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/pipeline-executions",
      {
        body: createPipelineExecutionInputSchema,
        response: responseSchemas({
          ...commandResponses,
          400: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "createPipelineExecution",
          description:
            "Starts a run of the pipeline's active version, or of `version` when given, and advances it to its first step.",
          tags: ["PipelineExecutions"],
        },
      },
      async ({ body, auth }) =>
        Result.unwrap(
          await createPipelineExecution(
            createPipelineExecutionInputSchema.parse(body),
            {
              ...appContext,
              userAuthz: auth.userAuthz,
              triggeredBy: "actor",
            },
          ),
        ),
    )
    .post(
      "/pipeline-executions/:pipelineExecutionId/visits/:visitId/rerun",
      {
        params: visitParamsSchema,
        response: responseSchemas(commandResponses),
        detail: {
          operationId: "rerunPipelineExecutionVisit",
          description:
            "Reruns a step visit: it and every visit downstream of it are superseded and the node is visited again.",
          tags: ["PipelineExecutions"],
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await rerunVisit(
            {
              pipelineExecutionId:
                visitParamsSchema.parse(params).pipelineExecutionId,
              visitId: visitParamsSchema.parse(params).visitId,
            },
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        ),
    )
    .post(
      "/pipeline-executions/:pipelineExecutionId/visits/:visitId/route",
      {
        params: visitParamsSchema,
        body: overruleVisitRouteBodySchema,
        response: responseSchemas({
          ...commandResponses,
          200: z.union([pipelineExecutionSchema, overrulePreviewResultSchema]),
        }),
        detail: {
          operationId: "overrulePipelineExecutionRoute",
          description:
            'Overrules the routes a succeeded step visit took: `routes` is the full set to take (exactly one on a `match: "first"` node), each picked by `{ kind, index }`, `{ kind: "otherwise" }`, target node `{ to }` or `{ label }`. The visit keeps its result; the overrule is recorded with `reason` in its routing. On a `match: "first"` node every visit after it is superseded, its open Tasks cancelled, and the run (reopened if it had finished) continues along the new route. On a `match: "all"` node only the lanes whose route changed are cancelled or started, and merges whose input changes fire again. Only routes the pipeline marks `overridable` can be turned on or off (`PIPELINE_RUN_ROUTE_NOT_OVERRIDABLE`, `meta.routes`). Args that resolve to nothing refuse the overrule (`PIPELINE_RUN_ROUTE_ARGS_MISSING`, `meta.missing`) unless `acceptMissing` is true, which a route to a code step never allows. With `preview: true` nothing is written and the response is `{ preview }`: the visits superseded, Tasks cancelled, lanes added and removed, merges that fire again, nodes started, whether the run reopens and the missing args; refusals come back as for a real overrule. Requires `executions:write`.',
          tags: ["PipelineExecutions"],
        },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await overruleVisitRoute(
            {
              ...visitParamsSchema.parse(params),
              ...overruleVisitRouteBodySchema.parse(body),
            },
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        ),
    )
    .post(
      "/pipeline-executions/:pipelineExecutionId/questions/:questionId/answer",
      {
        params: continueWithoutReplyInputSchema,
        body: answerQuestionBodySchema,
        response: responseSchemas({
          ...commandResponses,
          200: workItemCommentSchema,
        }),
        detail: {
          operationId: "answerQuestion",
          description:
            "Answers the visit waiting on an open question: the reply is saved as a threaded comment under the question's comment, the question becomes answered by the caller, and the wait's result is `{ replied: true, body, commentId }`. A question that isn't open is rejected (`PIPELINE_RUN_QUESTION_NOT_OPEN`) and nothing is saved. Requires `comments:create`.",
          tags: ["PipelineExecutions"],
        },
      },
      async ({ params, body, auth }) =>
        await answerQuestionAndAdvance(
          {
            ...continueWithoutReplyInputSchema.parse(params),
            body: answerQuestionBodySchema.parse(body).body,
          },
          { ...appContext, userAuthz: auth.userAuthz },
        ),
    )
    .post(
      "/pipeline-executions/:pipelineExecutionId/questions/:questionId/continue",
      {
        params: continueWithoutReplyInputSchema,
        response: responseSchemas(commandResponses),
        detail: {
          operationId: "continueWithoutReply",
          description:
            "Resumes the visit waiting on an open question without a reply: the question becomes answered with no answer comment and the wait's result is `{ replied: false, body: null, commentId: null }`. Requires `executions:write`.",
          tags: ["PipelineExecutions"],
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await continueWithoutReply(
            continueWithoutReplyInputSchema.parse(params),
            {
              ...appContext,
              userAuthz: auth.userAuthz,
            },
          ),
        ),
    )
    .put(
      "/pipeline-executions/:pipelineExecutionId/cancel",
      {
        params: pipelineExecutionIdParamsSchema,
        response: responseSchemas(commandResponses),
        detail: {
          operationId: "cancelPipelineExecution",
          tags: ["PipelineExecutions"],
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await cancelPipelineExecution(
            pipelineExecutionIdParamsSchema.parse(params).pipelineExecutionId,
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        ),
    );
