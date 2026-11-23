/**
 * The shop's inventory MCP server (`../inventory-mcp.mjs`), bound to its
 * typed catalog. `mcp/inventory.tools.ts` is generated from the server's
 * `tools/list`; don't edit it.
 */
import { defineMcp } from "@scarn/sdk/definitions/steps";
import { inventoryTools } from "./mcp/inventory.tools";

export const inventory = defineMcp({
  type: "local",
  name: "inventory",
  command: ["bun", ".scarn/inventory-mcp.mjs"],
}).withTools(inventoryTools);
