import { Elysia } from "elysia";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { resolveTaskRunEnvironmentSecrets } from "@scarn/core/tasks/task-run/application/resolve-task-run-environment-secrets";
import {
  resolveTaskRunEnvironmentInputSchema,
  taskRunEnvironmentSchema,
} from "@scarn/core/tasks/task-run/contracts/task-run-environment-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { stdErrors, taskRunIdParamsSchema } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

/** Where the worker fetches the project secrets its environment needs. */
export const createTaskRunEnvironmentRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/task-runs/:taskRunId/environment",
      {
        params: taskRunIdParamsSchema,
        body: resolveTaskRunEnvironmentInputSchema,
        response: responseSchemas({
          200: taskRunEnvironmentSchema,
          400: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "resolveTaskRunEnvironment",
          tags: ["TaskRuns"],
          description:
            "Returns the values of the named project secrets for the task run's project, and lists the names the project has no secret for. Marks each returned secret used. Requires the claim token and `executions:write`. Only secrets referenced by the run's environment (its inline vars, or its pinned named environment version) or by its Task's extra connectors may be asked for; any other name returns 403 `SECRET_NOT_REFERENCED`.",
        },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await resolveTaskRunEnvironmentSecrets(
            taskRunIdParamsSchema.parse(params).taskRunId,
            resolveTaskRunEnvironmentInputSchema.parse(body),
            {
              userAuthz: auth.userAuthz,
              taskRepo: appContext.taskRepo,
              taskRunRepo: appContext.taskRunRepo,
              taskExecutionConfigRepo: appContext.taskExecutionConfigRepo,
              environmentRepo: appContext.environmentRepo,
              secretRepo: appContext.secretRepo,
              secretCipher: appContext.secretCipher,
              timeProvider: appContext.timeProvider,
            },
          ),
        ),
    );
