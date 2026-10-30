/**
 * The `scarn` plugin RPC: the worker's replacement for v1's
 * `/experimental/tool/ids` + `/experimental/tool` enumeration, which has no v2
 * server route. Served by the plugin from `ctx.tool.list()` and called by the
 * worker via `client.rpc.call({ rpcID: "scarn", method: "listTools" })`.
 */

export const SCARN_RPC_ID = "scarn";
export const SCARN_LIST_TOOLS_METHOD = "listTools";

/**
 * One registered tool as reported over the RPC. `inputSchema` is the tool's
 * input JSON Schema when it was declared as plain JSON Schema, and `null` when
 * it was declared as an Effect or Standard Schema (those are not portable over
 * the wire).
 */
export type ScarnRegisteredTool = {
  id: string;
  inputSchema: Record<string, unknown> | null;
};

export type ScarnListToolsOutput = {
  tools: ScarnRegisteredTool[];
};

export const SCARN_RPC_DEFINITION = {
  id: SCARN_RPC_ID,
  methods: {
    [SCARN_LIST_TOOLS_METHOD]: {
      input: { type: "object" },
      output: {
        type: "object",
        properties: {
          tools: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                inputSchema: { type: ["object", "null"] },
              },
              required: ["id", "inputSchema"],
            },
          },
        },
        required: ["tools"],
      },
    },
  },
  events: {},
} as const;

// eslint-disable-next-line local/no-unknown-parameter-type -- a registered tool's input may be JSON Schema, Effect Schema or Standard Schema
function isPlainJsonSchema(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return !("~standard" in value) && !("ast" in value);
}

export function describeRegisteredTools(
  tools: ReadonlyArray<{ readonly id: string; readonly input: unknown }>,
): ScarnRegisteredTool[] {
  return tools.map((tool) => ({
    id: tool.id,
    inputSchema: isPlainJsonSchema(tool.input)
      ? (JSON.parse(JSON.stringify(tool.input)) as Record<string, unknown>)
      : null,
  }));
}
