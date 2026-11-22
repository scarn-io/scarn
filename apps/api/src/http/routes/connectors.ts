import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import {
  connectorSummarySchema,
  listConnectorSummaries,
} from "@scarn/core/common/contracts/connectors";
import { createAuthenticated } from "./authenticated";
import { stdErrors } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

/**
 * The Scarn connector catalog: what each connector is and the variables an
 * environment must provide for it. MCP configs stay server-side.
 */
export const createConnectorRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .get(
      "/connectors",
      {
        response: responseSchemas({
          200: z.array(connectorSummarySchema),
          ...stdErrors,
        }),
        detail: { operationId: "listConnectors", tags: ["Connectors"] },
      },
      () => listConnectorSummaries(),
    );
