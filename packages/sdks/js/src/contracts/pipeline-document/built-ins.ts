/**
 * Built-in error names and the schemas of built-in values: wait results,
 * the input a `reply` wait takes, and caught errors.
 */
import type { JsonSchema } from "./json";

export const BUILT_IN_ERRORS = [
  "Scarn.All",
  "Scarn.StepFailed",
  "Scarn.HealthCheckFailed",
  "Scarn.Timeout",
  "Scarn.HeartbeatTimeout",
  "Scarn.MaxRunsExceeded",
  "Scarn.MaxTurnsExceeded",
  "Scarn.ConcurrencyGroupFull",
  "Scarn.ConditionError",
  "Scarn.ArgsError",
  "Scarn.LogArchiveFailed",
  "Scarn.WorkItemChangesInvalid",
  "Scarn.WorkItemNotNative",
  "Scarn.McpToolError",
  "Scarn.McpUnavailable",
  "Scarn.McpOutputInvalid",
  "ManagedConnectionAuthorityLost",
  "ManagedConnectionNotReady",
] as const;

/** The errors a wait node can raise, so the only names its `catch` may use. */
export const WAIT_ERRORS = [
  "Scarn.All",
  "Scarn.MaxRunsExceeded",
  "Scarn.ArgsError",
] as const;

/**
 * The result of a `wait` node with `for: decision`: the chosen action's key
 * and the person's text. With no actions (an invalid node) `action` is any
 * string, so only the missing actions are reported.
 */
export function decisionResultSchema(
  actions: readonly { key: string }[],
): JsonSchema {
  const keys = [...new Set(actions.map((action) => action.key))];
  return {
    title: "DecisionResult",
    type: "object",
    properties: {
      action:
        keys.length === 0 ? { type: "string" } : { type: "string", enum: keys },
      body: { type: ["string", "null"] },
    },
    required: ["action", "body"],
    additionalProperties: false,
  };
}

/** The result of a `wait` node with `for: reply`; `replied: false` is "continue without reply". */
export const REPLY_RESULT_SCHEMA: JsonSchema = {
  title: "ReplyResult",
  type: "object",
  properties: {
    replied: { type: "boolean" },
    body: { type: ["string", "null"] },
    commentId: { type: ["string", "null"] },
  },
  required: ["replied", "body", "commentId"],
  additionalProperties: false,
};

/** The result of a conversation step (a step with no result schema): the conversation and the agent's last message. */
export const CONVERSATION_RESULT_SCHEMA: JsonSchema = {
  title: "ConversationResult",
  type: "object",
  properties: {
    conversationId: { type: "string" },
    summary: { type: "string" },
  },
  required: ["conversationId", "summary"],
  additionalProperties: false,
};

/**
 * The result of an MCP tool step whose tool declares no output schema: the
 * content blocks of the `tools/call` result as the server sent them, and its
 * `structuredContent` when there is one.
 */
export const MCP_TOOL_CONTENT_RESULT_SCHEMA: JsonSchema = {
  title: "McpToolContentResult",
  type: "object",
  properties: {
    content: {
      type: "array",
      items: {
        type: "object",
        properties: { type: { type: "string" } },
        required: ["type"],
      },
    },
    structuredContent: { type: ["object", "null"] },
  },
  required: ["content", "structuredContent"],
  additionalProperties: false,
};

/** What every transition into a `reply` wait must pass. */
export const REPLY_INPUT_SCHEMA: JsonSchema = {
  type: "array",
  items: { type: "string" },
};

export const ERROR_SCHEMA: JsonSchema = {
  title: "Error",
  type: "object",
  properties: {
    name: { type: "string" },
    message: { type: "string" },
    cause: {},
  },
  required: ["name", "message"],
};
