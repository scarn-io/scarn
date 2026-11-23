/**
 * `ld-codestep-with-mcp`'s steps, both typed from the inventory catalog and run on the
 * managed `bun1` runtime, where the worker starts the stdio server.
 *
 * - `lookupSku` is an MCP tool step: its input is `lookup_sku`'s arguments
 *   and its result the tool's typed output, so the pipeline routes on
 *   `r.result.found`.
 * - `reserveOrder` is a code step that calls the same server through
 *   `context.mcp`: it re-reads the stock, fails with its declared
 *   `Order.OutOfStock` when the order doesn't fit, and otherwise reserves it.
 */
import {
  codeStep,
  Runtime,
  type CodeStepContext,
} from "@scarn/sdk/definitions/steps";
import { z } from "zod";

import { inventory } from "./inventory";

const environment = { runtime: Runtime.managed.bun1() };
const mcps = { inventory };

export const lookupSku = inventory.tools.lookupSku.step({
  key: "lookup-sku",
  environment,
});

/**
 * `reserve-order`'s `fn`, exported so a unit test can pass
 * `createFakeMcpClients({ inventory }, ...)` as `mcp` and `failStep` as
 * `fail`.
 */
export async function reserveOrderFn(
  { sku, quantity }: { sku: string; quantity: number },
  { mcp, fail }: CodeStepContext<typeof mcps, "Order.OutOfStock">,
) {
  const { inStock } = await mcp.inventory.lookupSku({ sku });
  if (inStock < quantity) {
    fail(
      "Order.OutOfStock",
      `${sku}: ${String(inStock)} in stock, ordered ${String(quantity)}`,
    );
  }
  return mcp.inventory.reserveStock({ sku, quantity });
}

export const reserveOrder = codeStep({
  key: "reserve-order",
  name: "Reserve the order",
  environment,
  mcps,
  errors: ["Order.OutOfStock"],
  inputSchema: z.object({ sku: z.string(), quantity: z.number().int() }),
  resultSchema: z.object({
    reservationId: z.string(),
    remaining: z.number(),
  }),
  fn: reserveOrderFn,
});
