import { z } from "zod";
import { connectorAuthValues } from "@scarn/sdk/connectors";

export {
  CONNECTOR_CATALOG,
  connectorIdsSchema,
  listConnectorSummaries,
} from "@scarn/sdk/connectors";
export type { ConnectorSummary } from "@scarn/sdk/connectors";

/** A catalog connector as the API lists it: no MCP config. */
export const connectorSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  auth: z.enum(connectorAuthValues),
  requiredVars: z.array(
    z.object({ name: z.string(), description: z.string() }),
  ),
});
