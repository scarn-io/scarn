import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { actOnTaskAndAdvance } from "@scarn/core/pipeline-executions/pipeline-run/application/task-and-advance";
import { conversationSchema } from "@scarn/core/conversations/conversation/contracts/conversation-contracts";
import { decideGrantRequest } from "@scarn/core/tasks/task/application/decide-grant-request";
import { listTaskGrantRequests } from "@scarn/core/tasks/task/application/list-task-grant-requests";
import { getTaskInputSchema } from "@scarn/core/tasks/task/contracts/task-contracts";
import {
  decideGrantRequestBodySchema,
  grantRequestIdParamsSchema,
  grantRequestListSchema,
} from "@scarn/core/tasks/grant-request/contracts/grant-request-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { stdErrors } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

/** A Task's agent's requests for more work item grants, and deciding them. */
export const createTaskGrantRequestRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/task-grant-requests/:grantRequestId/decision",
      {
        params: grantRequestIdParamsSchema,
        body: decideGrantRequestBodySchema,
        response: responseSchemas({
          200: conversationSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "decideTaskGrantRequest",
          description:
            "Decides a Task's pending grant request: `approved` lists the grants to add to the Task (each covered by a requested one, labels may be a subset; `[]` denies), with an optional `note` for the agent. Posts a `system` message and resumes the Task. Requires `executions:write`, plus `work-items:write` when an approved grant isn't `read`. 409 `GRANT_REQUEST_NOT_PENDING` when it was already closed or the Task no longer waits; 422 `GRANT_REQUEST_APPROVAL_INVALID` for an approval not covered by the request.",
          tags: ["Tasks"],
        },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await actOnTaskAndAdvance(
            decideGrantRequest,
            { ...grantRequestIdParamsSchema.parse(params), ...body },
            { ...appContext, userAuthz: auth.userAuthz },
          ),
        ),
    )
    .get(
      "/tasks/:taskId/grant-requests",
      {
        params: z.object({ taskId: getTaskInputSchema }),
        response: responseSchemas({
          200: grantRequestListSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "listTaskGrantRequests",
          description:
            "A Task's grant requests, oldest first. Requires `executions:read`.",
          tags: ["Tasks"],
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await listTaskGrantRequests(params.taskId, {
            userAuthz: auth.userAuthz,
            taskRepo: appContext.taskRepo,
            grantRequestRepo: appContext.grantRequestRepo,
          }),
        ),
    );
