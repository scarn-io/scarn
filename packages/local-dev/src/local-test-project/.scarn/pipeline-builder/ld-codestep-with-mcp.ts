/**
 * Typed MCP calls with no agent: the `lookup-sku` tool step routes on the
 * catalog-typed `found`, then the `reserve-order` code step calls the
 * inventory server through `context.mcp`. A short stock fails it with the
 * declared `Order.OutOfStock`, which the pipeline catches.
 */
import {
  definePipeline,
  equal,
  fail,
  succeed,
  workItemField,
} from "@scarn/sdk/pipelines";
import { lookupSku, reserveOrder } from "./mcp-steps";

const reserved = succeed("reserved");
const backordered = succeed("backordered");
const unknownSku = fail("unknown-sku", { error: "UnknownSku" });

export default definePipeline({
  key: "ld-codestep-with-mcp",
  title: "Local dev: typed MCP tool step and code step",
  start: lookupSku({ sku: workItemField("sku", "sku") }),
  flow: [
    lookupSku.settings({ title: "Look up the SKU" }).next({
      routes: [
        {
          when: (r) => equal(r.result.found, true),
          to: (r) =>
            reserveOrder({
              sku: r.result.sku,
              quantity: workItemField("quantity", "quantity"),
            }),
        },
      ],
      otherwise: unknownSku,
    }),
    reserveOrder
      .settings({ title: "Reserve the order" })
      .catch(["Order.OutOfStock"], backordered)
      .next(reserved),
  ],
});
