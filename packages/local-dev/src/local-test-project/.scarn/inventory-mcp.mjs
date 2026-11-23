/**
 * The shop's inventory as a dependency-free stdio MCP server, for `ld-codestep-with-mcp`.
 * Seed mirrors it into the sandbox at `.scarn/inventory-mcp.mjs`, and the
 * worker starts it with `bun` inside the step's `bun1` container. Stock is
 * fixed, and each process starts from it again.
 *
 * - `lookup_sku` returns `structuredContent` for any SKU, with `found: false`
 *   for one the shop doesn't sell.
 * - `reserve_stock` reserves units of a SKU, or returns an `isError` result
 *   when the SKU is unknown or short.
 *
 * `mcp/inventory.lock.json` and `mcp/inventory.tools.ts` in the pipeline
 * builder are generated from `tools/list` here; after changing a tool, run
 * `bun run --filter @scarn/local-dev pull-inventory`.
 */
import { createInterface } from "node:readline";

const stock = new Map([
  ["MUG-01", { name: "Acme mug", inStock: 12 }],
  ["TEE-02", { name: "Acme tee", inStock: 1 }],
  ["CAP-03", { name: "Acme cap", inStock: 0 }],
]);

const tools = [
  {
    name: "lookup_sku",
    title: "Look up a SKU",
    description: "Returns a SKU's name and how many units are in stock.",
    inputSchema: {
      type: "object",
      properties: { sku: { type: "string" } },
      required: ["sku"],
    },
    outputSchema: {
      type: "object",
      properties: {
        sku: { type: "string" },
        found: { type: "boolean" },
        name: { type: "string" },
        inStock: { type: "integer" },
      },
      required: ["sku", "found", "inStock"],
    },
  },
  {
    name: "reserve_stock",
    title: "Reserve stock",
    description: "Reserves units of a SKU for an order.",
    inputSchema: {
      type: "object",
      properties: {
        sku: { type: "string" },
        quantity: { type: "integer", minimum: 1 },
      },
      required: ["sku", "quantity"],
    },
    outputSchema: {
      type: "object",
      properties: {
        reservationId: { type: "string" },
        remaining: { type: "integer" },
      },
      required: ["reservationId", "remaining"],
    },
  },
];

function structured(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function toolError(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

function callTool(name, args) {
  const sku = String(args.sku);
  const item = stock.get(sku);
  if (name === "lookup_sku") {
    return structured(
      item
        ? { sku, found: true, name: item.name, inStock: item.inStock }
        : { sku, found: false, inStock: 0 },
    );
  }
  if (name === "reserve_stock") {
    const quantity = Number(args.quantity);
    if (!item) return toolError(`unknown SKU ${sku}`);
    if (item.inStock < quantity) {
      return toolError(
        `only ${String(item.inStock)} of ${sku} in stock, asked for ${String(quantity)}`,
      );
    }
    item.inStock -= quantity;
    return structured({
      reservationId: `res-${sku}-${String(Date.now())}`,
      remaining: item.inStock,
    });
  }
  return toolError(`unknown tool ${name}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

const handlers = {
  initialize: (params) => ({
    protocolVersion: params?.protocolVersion ?? "2025-06-18",
    capabilities: { tools: {} },
    serverInfo: { name: "inventory", version: "1.0.0" },
  }),
  ping: () => ({}),
  "tools/list": () => ({ tools }),
  "tools/call": (params) => callTool(params.name, params.arguments ?? {}),
};

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const handler = handlers[message.method];
  if (handler) {
    send({ id: message.id, result: handler(message.params) });
  } else {
    send({
      id: message.id,
      error: { code: -32601, message: `Unknown method ${message.method}` },
    });
  }
});
