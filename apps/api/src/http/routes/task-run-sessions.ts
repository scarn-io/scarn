import { Elysia } from "elysia";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { createSessionUploadUrl } from "@scarn/core/tasks/task-run/application/create-session-upload-url";
import {
  createSessionUploadUrlInputSchema,
  sessionUploadUrlSchema,
} from "@scarn/core/tasks/task-run/contracts/task-run-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { stdErrors, taskRunIdParamsSchema } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

/** Where the worker saves a task run's agent session before it yields. */
export const createTaskRunSessionRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/task-runs/:taskRunId/session-upload-url",
      {
        params: taskRunIdParamsSchema,
        body: createSessionUploadUrlInputSchema,
        response: responseSchemas({
          200: sessionUploadUrlSchema,
          402: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "createSessionUploadUrl",
          tags: ["TaskRuns"],
          description:
            "Mints a presigned PUT URL for the task run's exported agent session (`tasks/<taskRunId>/session.json`). The worker uploads the export, then passes the returned `objectKey` when it yields. Requires the claim token and `executions:write`.",
        },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await createSessionUploadUrl(
            taskRunIdParamsSchema.parse(params).taskRunId,
            createSessionUploadUrlInputSchema.parse(body),
            {
              userAuthz: auth.userAuthz,
              taskRunRepo: appContext.taskRunRepo,
              objectStore: appContext.objectStore,
              timeProvider: appContext.timeProvider,
              orgRepo: appContext.orgRepo,
              usageMeterRepo: appContext.usageMeterRepo,
            },
          ),
        ),
    );
