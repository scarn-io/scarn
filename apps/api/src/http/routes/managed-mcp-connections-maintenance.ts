import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { sweepManagedConnectionLeftovers } from "@scarn/core/connections/managed-mcp-connection/application/sweep-managed-connection-leftovers";
import { createServiceAuthenticated } from "./service-authenticated";
import { stdErrors } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

const sweepManagedConnectionsResultSchema = z.object({
  attemptsExpired: z.number().int().nonnegative(),
  candidatesExpired: z.number().int().nonnegative(),
  grantsDeleted: z.number().int().nonnegative(),
  eventsDeleted: z.number().int().nonnegative(),
  launchesClosed: z.number().int().nonnegative(),
  launchesDeleted: z.number().int().nonnegative(),
});

// Machine-to-machine cleanup of managed MCP connection leftovers: lapsed
// authorization attempts and candidates, and retired grants and events past
// their 30-day retention. Invoked daily by AWS EventBridge (see
// infra/managed-connections-sweep-schedule.tf), authenticated with the shared
// bearer token via `createServiceAuthenticated` (NOT a user session). The use
// case is idempotent, so a missed or duplicate invocation is harmless.
export const createManagedMcpConnectionsMaintenanceRoutes = (
  appContext: AppContext,
) =>
  new Elysia().use(createServiceAuthenticated()).post(
    "/internal/connections/sweep",
    {
      response: responseSchemas({
        200: sweepManagedConnectionsResultSchema,
        ...stdErrors,
      }),
      detail: {
        operationId: "sweepManagedMcpConnections",
        tags: ["Connections"],
      },
    },
    async () =>
      await sweepManagedConnectionLeftovers({
        managedConnectionRepo: appContext.managedConnectionRepo,
        managedOAuthAttemptRepo: appContext.managedOAuthAttemptRepo,
        managedOAuthGrantRepo: appContext.managedOAuthGrantRepo,
        managedConnectionEventRepo: appContext.managedConnectionEventRepo,
        managedLaunchRepo: appContext.managedLaunchRepo,
        timeProvider: appContext.timeProvider,
        logger: appContext.logger,
      }),
  );
