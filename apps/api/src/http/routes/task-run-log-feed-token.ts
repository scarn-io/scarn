import { Elysia } from "elysia";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import {
  issueLogFeedReadToken,
  issueLogFeedWriteToken,
} from "@scarn/core/tasks/task-log/application/issue-log-feed-token";
import {
  issueLogFeedWriteTokenInputSchema,
  logFeedTokenSchema,
} from "@scarn/core/tasks/task-log/contracts/log-feed-token-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import {
  createAuthenticated,
  createOptionallyAuthenticated,
} from "./authenticated";
import { stdErrors, taskRunIdParamsSchema } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

// The write side: the claim holder refreshes its write token for the run's
// live log feed. Always requires a real session.
const createTaskRunLogFeedWriteTokenRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/task-runs/:taskRunId/log-feed-token",
      {
        params: taskRunIdParamsSchema,
        body: issueLogFeedWriteTokenInputSchema,
        response: responseSchemas({
          200: logFeedTokenSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "issueLogFeedWriteToken",
          tags: ["TaskRuns"],
          description:
            "Refreshes the worker's write token for the task run's live log feed. Requires the claim token and `executions:write`. 404 when the live feed is not configured; append over `POST /task-runs/:taskRunId/logs` instead.",
        },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await issueLogFeedWriteToken(
            taskRunIdParamsSchema.parse(params).taskRunId,
            issueLogFeedWriteTokenInputSchema.parse(body),
            {
              userAuthz: auth.userAuthz,
              taskRunRepo: appContext.taskRunRepo,
              orgRepo: appContext.orgRepo,
              logFeedConnection: appContext.logFeedConnection,
              timeProvider: appContext.timeProvider,
            },
          ),
        ),
    );

// The read side: a viewer's read token. Serves non-members of a public
// project, including anonymous callers, via `createOptionallyAuthenticated`,
// like `GET /task-runs/:taskRunId/logs`.
const createTaskRunLogFeedReadTokenRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(
      createOptionallyAuthenticated(appContext.createUserAuthorizationService),
    )
    .get(
      "/task-runs/:taskRunId/log-feed-token",
      {
        params: taskRunIdParamsSchema,
        response: responseSchemas({
          200: logFeedTokenSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "issueLogFeedReadToken",
          tags: ["TaskRuns"],
          description:
            "A read token for the task run's live log feed. Requires `executions:read`. 404 when the live feed is not configured; poll `GET /task-runs/:taskRunId/logs` instead.",
        },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await issueLogFeedReadToken(
            taskRunIdParamsSchema.parse(params).taskRunId,
            {
              userAuthz: auth.userAuthz,
              taskRunRepo: appContext.taskRunRepo,
              orgRepo: appContext.orgRepo,
              logFeedConnection: appContext.logFeedConnection,
              timeProvider: appContext.timeProvider,
            },
          ),
        ),
    );

export const createTaskRunLogFeedTokenRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createTaskRunLogFeedWriteTokenRoutes(appContext))
    .use(createTaskRunLogFeedReadTokenRoutes(appContext));
