/**
 * The errors a code step's `context.mcp` calls throw (ADR 0016). Each is a
 * `StepError` carrying the built-in name an `mcp_tool` step fails with, so a
 * pipeline can `retry` or `catch` an uncaught one the same way.
 */
import type { McpBridgeUnavailableReason } from "../../contracts/mcp-bridge";
import type { McpContentBlock } from "../../pipelines/types";
import { StepError } from "./step-error";

export type McpUnavailableReason =
  | McpBridgeUnavailableReason
  /** No bridge env: the step isn't running inside a Scarn run. */
  | "no_bridge"
  /** The bridge doesn't know the server key (404). */
  | "not_declared"
  /** The bridge couldn't be reached, rejected the token or answered badly. */
  | "bridge"
  /** A fake client has no fake for the tool. */
  | "no_fake";

/** The tool ran and reported `isError`. */
export class McpToolError extends StepError<"Scarn.McpToolError"> {
  readonly content: McpContentBlock[];

  constructor(message: string, content: McpContentBlock[]) {
    super("Scarn.McpToolError", message, { code: "SCARN_MCP_TOOL_ERROR" });
    this.content = content;
  }
}

/** The server couldn't be started, reached or used, or has no such tool. */
export class McpUnavailableError extends StepError<"Scarn.McpUnavailable"> {
  readonly reason: McpUnavailableReason;
  readonly detail: string;

  constructor(message: string, reason: McpUnavailableReason, detail: string) {
    super("Scarn.McpUnavailable", message, { code: "SCARN_MCP_UNAVAILABLE" });
    this.reason = reason;
    this.detail = detail;
  }
}

/** The tool's `structuredContent` is missing or doesn't match the catalog's `output`. */
export class McpOutputInvalidError extends StepError<"Scarn.McpOutputInvalid"> {
  constructor(message: string) {
    super("Scarn.McpOutputInvalid", message, {
      code: "SCARN_MCP_OUTPUT_INVALID",
    });
  }
}

/** The arguments don't match the catalog's `input`, or the bridge rejected them. */
export class McpArgsError extends StepError<"Scarn.ArgsError"> {
  constructor(message: string) {
    super("Scarn.ArgsError", message, { code: "SCARN_ARGS_ERROR" });
  }
}

/** The call ran past its time limit. */
export class McpTimeoutError extends StepError<"Scarn.Timeout"> {
  constructor(message: string) {
    super("Scarn.Timeout", message, { code: "SCARN_MCP_TOOL_TIMEOUT" });
  }
}
