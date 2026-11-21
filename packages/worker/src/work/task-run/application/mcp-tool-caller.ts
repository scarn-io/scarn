import type { AnyJsonObject } from "../../../common/contracts/json";
import type { ResolvedOpenCodeMcpServerConfig } from "../../../common/contracts/opencode-mcp";

/**
 * Port for an `mcp_tool` step: call one tool on one resolved MCP server, from
 * the worker process, with no agent in between.
 *
 * Only the server's own process lives in the step's runtime: a `local`
 * server starts inside the container (`placement.kind === "container"`) or on
 * the host; a `remote` server (managed relay included) is always reached from
 * the worker host. A `local` server's `cwd` is resolved against
 * `placement.workspaceDir`, which is also its default.
 *
 * Once `tools/call` has been sent there is no automatic retry, since a tool
 * call may not be idempotent; only a connection failure before that may be
 * retried, once. `timeoutMs` bounds the whole call, connecting included.
 */
export interface McpToolCaller {
  call(input: McpToolCallInput): Promise<McpToolCallOutcome>;
}

export type McpToolCallPlacement =
  | { kind: "container"; containerId: string; workspaceDir: string }
  | { kind: "host"; workspaceDir: string };

export type McpToolCallInput = {
  server: ResolvedOpenCodeMcpServerConfig;
  placement: McpToolCallPlacement;
  tool: string;
  args: AnyJsonObject;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
};

/** One MCP content block (`text`, `image`, `resource`, …) as the server sent it. */
export type McpContentBlock = AnyJsonObject & { type: string };

export type McpUnavailableReason =
  "start" | "connect" | "initialize" | "tool_not_found";

export type McpToolCallOutcome =
  | {
      status: "ok";
      content: McpContentBlock[];
      structuredContent: AnyJsonObject | null;
    }
  | { status: "tool_error"; content: McpContentBlock[] }
  | { status: "unavailable"; reason: McpUnavailableReason; detail: string }
  | { status: "timeout" }
  | { status: "aborted" };
