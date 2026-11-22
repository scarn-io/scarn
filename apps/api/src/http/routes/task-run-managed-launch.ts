import { Elysia } from "elysia";
import { registerManagedLaunch } from "@scarn/core/connections/managed-mcp-connection/application/register-managed-launch";
import {
  managedLaunchSchema,
  registerManagedLaunchInputSchema,
} from "@scarn/core/connections/managed-mcp-connection/contracts/managed-launch-contracts";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { stdErrors, taskRunIdParamsSchema } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

/** Where the worker registers the managed connections its launch relays to. */
export const createTaskRunManagedLaunchRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/task-runs/:taskRunId/managed-launch",
      {
        params: taskRunIdParamsSchema,
        body: registerManagedLaunchInputSchema,
        response: responseSchemas({
          200: managedLaunchSchema,
          400: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "registerTaskRunManagedLaunch",
          tags: ["TaskRuns"],
          description:
            "Registers the task run's launch with the project's managed MCP connections. Returns one entry per MCP server in the run's config whose `auth` names a connection: the relay URL to call and the relay capability to send as its bearer. Capabilities are shown only in this response; registering again under the same claim rotates them. Requires the claim token and `executions:write`. The body carries the URL the worker resolved for each of those servers (`entries`) and for every other enabled remote server (`remotesWithoutAuth`). Responds 400 `MANAGED_LAUNCH_ENTRY_URL_MISSING` when `entries` lacks one of the run's connection-auth servers; 409 `MANAGED_CONNECTION_NOT_READY` (with `state`, `reasonCode`, `key`, `connection` and the connection's `label`, null when the project has no such connection) when a referenced connection is missing or not serving; 422 `SCARN_MCP_CONNECTION_AUTH_INVALID` (with `key` and `connection`) when a server's URL isn't its connection's, or a server without `auth` points at a connection's URL.",
        },
      },
      async ({ params, body, auth }) =>
        Result.unwrap(
          await registerManagedLaunch(
            taskRunIdParamsSchema.parse(params).taskRunId,
            registerManagedLaunchInputSchema.parse(body),
            {
              userAuthz: auth.userAuthz,
              taskRunRepo: appContext.taskRunRepo,
              taskExecutionConfigRepo: appContext.taskExecutionConfigRepo,
              managedConnectionRepo: appContext.managedConnectionRepo,
              managedLaunchRepo: appContext.managedLaunchRepo,
              managedConnectionEventRepo: appContext.managedConnectionEventRepo,
              timeProvider: appContext.timeProvider,
              apiBaseUrl: appContext.apiBaseUrl,
            },
          ),
        ),
    );
