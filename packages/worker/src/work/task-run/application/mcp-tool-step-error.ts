/**
 * The named errors an `mcp_tool` step fails with, so a pipeline's `retry` or
 * `catch` can match them. `buildTaskRunFailurePayload` reports
 * {@link McpToolStepError.errorName} and {@link McpToolStepError.code} as the
 * run's `errorJson`.
 */
export const MCP_TOOL_STEP_ERRORS = {
  argsError: { name: "Scarn.ArgsError", code: "SCARN_ARGS_ERROR" },
  toolError: { name: "Scarn.McpToolError", code: "SCARN_MCP_TOOL_ERROR" },
  unavailable: { name: "Scarn.McpUnavailable", code: "SCARN_MCP_UNAVAILABLE" },
  outputInvalid: {
    name: "Scarn.McpOutputInvalid",
    code: "SCARN_MCP_OUTPUT_INVALID",
  },
  timeout: { name: "Scarn.Timeout", code: "SCARN_MCP_TOOL_TIMEOUT" },
} as const;

export type McpToolStepErrorKind = keyof typeof MCP_TOOL_STEP_ERRORS;

export class McpToolStepError extends Error {
  readonly errorName: string;
  readonly code: string;

  constructor(kind: McpToolStepErrorKind, message: string) {
    super(message);
    this.name = "McpToolStepError";
    this.errorName = MCP_TOOL_STEP_ERRORS[kind].name;
    this.code = MCP_TOOL_STEP_ERRORS[kind].code;
  }
}
