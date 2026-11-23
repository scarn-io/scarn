/**
 * MCP bridge contract shared by the SDK and the worker (ADR 0016). A code
 * step's `context.mcp` client posts one tool call to the per-run bridge the
 * worker serves; the worker makes the call on the step's own MCP server and
 * answers with the raw outcome. Argument and output validation happen in the
 * SDK, so the bridge needs no tool schemas.
 *
 * Status codes besides 200: 400 for a malformed request, 401 for a missing or
 * wrong bearer token, 404 for a server key the step didn't declare, and 413
 * for a request body that is too large. Those carry an error body.
 */
import { z } from "zod";

/** The bridge's base URL, as seen from inside the step's container. */
export const MCP_BRIDGE_URL_ENV = "SCARN_MCP_BRIDGE_URL";

/** The bearer token every bridge request must send. */
export const MCP_BRIDGE_TOKEN_ENV = "SCARN_MCP_BRIDGE_TOKEN";

export const MCP_BRIDGE_CALL_METHOD = "POST";
export const MCP_BRIDGE_CALL_PATH = "/mcp/call";

export const mcpBridgeCallRequestSchema = z
  .object({
    /** The server key in the step's `mcps`. */
    server: z.string().min(1),
    /** The tool's name on the server, as in `tools/call`. */
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
    /** A cap the caller asks for; the worker may apply a smaller one. */
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();
export type McpBridgeCallRequest = z.infer<typeof mcpBridgeCallRequestSchema>;

export const mcpBridgeContentBlockSchema = z.looseObject({ type: z.string() });
export type McpBridgeContentBlock = z.infer<typeof mcpBridgeContentBlockSchema>;

export const mcpBridgeUnavailableReasonSchema = z.enum([
  "start",
  "connect",
  "initialize",
  "tool_not_found",
  /** The tool's result is over the bridge's 1 MiB result cap. */
  "output_too_large",
]);
export type McpBridgeUnavailableReason = z.infer<
  typeof mcpBridgeUnavailableReasonSchema
>;

export const mcpBridgeCallResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    content: z.array(mcpBridgeContentBlockSchema),
    structuredContent: z.record(z.string(), z.unknown()).nullable(),
  }),
  z.object({
    status: z.literal("tool_error"),
    content: z.array(mcpBridgeContentBlockSchema),
  }),
  z.object({
    status: z.literal("unavailable"),
    reason: mcpBridgeUnavailableReasonSchema,
    detail: z.string(),
  }),
  z.object({ status: z.literal("timeout") }),
]);
export type McpBridgeCallResponse = z.infer<typeof mcpBridgeCallResponseSchema>;

/** The body of every non-200 bridge response. */
export const mcpBridgeErrorResponseSchema = z.object({ error: z.string() });
export type McpBridgeErrorResponse = z.infer<
  typeof mcpBridgeErrorResponseSchema
>;
