import type {
  McpBridgeCallRequest,
  McpBridgeCallResponse,
} from "@scarn/sdk/contracts/mcp-bridge";
import type { AnyJsonObject } from "../../../common/contracts/json";
import type {
  OpenCodeMcpServers,
  ResolvedOpenCodeMcpServerConfig,
} from "../../../common/contracts/opencode-mcp";
import type { ProjectWorkLogger } from "../../../work/task-run/contracts/process-project-work-types";
import type {
  McpConnectionPool,
  McpConnectionPoolFactory,
} from "../../../work/task-run/application/mcp-connection-pool";
import type {
  McpToolCallOutcome,
  McpToolCallPlacement,
} from "../../../work/task-run/application/mcp-tool-caller";
import {
  DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
  formatBytes,
  formatMcpServerStartingLine,
  formatMcpToolCalledLine,
  MCP_TOOL_RESULT_MAX_BYTES,
  mcpServerTransportLabel,
  mcpToolOutcomeContentBlocks,
  mcpToolOutcomeLabel,
} from "../../../work/task-run/application/mcp-tool-step-observability";

/**
 * Answers a code step's bridged MCP tool calls for one run (ADR 0016): look
 * up the server, call it through the run's connection pool, cap the result
 * and log the call.
 *
 *   - A server key the step didn't declare is `not_declared`.
 *   - Each call is bounded by the smallest of the server's
 *     `timeout.execution`, the request's `timeoutMs` and
 *     {@link DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS} (decision 7).
 *   - A result whose serialized response is over {@link MCP_TOOL_RESULT_MAX_BYTES}
 *     becomes `unavailable` / `output_too_large`.
 *   - A call aborted by the run, by {@link close} or by the caller going away
 *     is `aborted`; the pool's `aborted` outcome never reaches the client as
 *     an outcome.
 *
 * Every call logs the same task-log line as an `mcp_tool` step, and the first
 * use of a server logs `mcp: starting <server> (<transport>)` (decision 11).
 * Lines carry arg keys and the content block count, never values or content.
 */

const LOG_SCOPE = "step";

export type McpBridgeCallResult =
  | { status: "outcome"; response: McpBridgeCallResponse }
  | { status: "not_declared" }
  | { status: "aborted" };

export type McpBridgeOptions = {
  servers: Record<string, ResolvedOpenCodeMcpServerConfig>;
  /** The step's authored servers, so a managed connection logs as `managed`. */
  authoredServers?: OpenCodeMcpServers | null | undefined;
  placement: McpToolCallPlacement;
  env: Record<string, string>;
  poolFactory: McpConnectionPoolFactory;
  logger?: ProjectWorkLogger | undefined;
  signal: AbortSignal;
  maxResultBytes?: number | undefined;
};

export class McpBridge {
  private readonly servers: Record<string, ResolvedOpenCodeMcpServerConfig>;
  /** The run's pool; also used by the step's health checks before `fn`. */
  readonly pool: McpConnectionPool;
  private readonly logger: ProjectWorkLogger | undefined;
  private readonly signal: AbortSignal;
  private readonly maxResultBytes: number;

  constructor(options: McpBridgeOptions) {
    this.servers = options.servers;
    this.logger = options.logger;
    this.signal = options.signal;
    this.maxResultBytes = options.maxResultBytes ?? MCP_TOOL_RESULT_MAX_BYTES;
    this.pool = options.poolFactory({
      servers: options.servers,
      placement: options.placement,
      env: options.env,
      signal: options.signal,
      onOpen: ({ serverKey, server, reopen }) => {
        if (reopen) return;
        this.logger?.log(
          LOG_SCOPE,
          formatMcpServerStartingLine(
            serverKey,
            mcpServerTransportLabel(serverKey, server, options.authoredServers),
          ),
          { server: serverKey },
        );
      },
    });
  }

  async call(
    request: McpBridgeCallRequest,
    signal?: AbortSignal,
  ): Promise<McpBridgeCallResult> {
    const server = this.servers[request.server];
    if (!server) {
      return { status: "not_declared" };
    }
    const startedAt = performance.now();
    const outcome = await this.pool.call(request.server, {
      tool: request.tool,
      args: request.args as AnyJsonObject,
      timeoutMs: mcpBridgeCallTimeoutMs(
        server.timeout?.execution,
        request.timeoutMs,
      ),
      signal: signal ? AbortSignal.any([this.signal, signal]) : this.signal,
    });
    const result = this.toResult(outcome);
    this.logger?.log(
      LOG_SCOPE,
      formatMcpToolCalledLine(
        request.server,
        request.tool,
        performance.now() - startedAt,
        result.status === "outcome"
          ? outcomeLabel(result.response)
          : mcpToolOutcomeLabel(outcome),
      ),
      {
        server: request.server,
        tool: request.tool,
        argKeys: Object.keys(request.args),
        contentBlocks: mcpToolOutcomeContentBlocks(outcome),
      },
    );
    return result;
  }

  /** Aborts in-flight calls and closes every connection; idempotent. */
  close(): Promise<void> {
    return this.pool.closeAll();
  }

  private toResult(outcome: McpToolCallOutcome): McpBridgeCallResult {
    if (outcome.status === "aborted") {
      return { status: "aborted" };
    }
    const bytes = Buffer.byteLength(JSON.stringify(outcome), "utf8");
    if (bytes <= this.maxResultBytes) {
      return { status: "outcome", response: outcome };
    }
    return {
      status: "outcome",
      response: {
        status: "unavailable",
        reason: "output_too_large",
        detail: `The tool returned a ${formatBytes(bytes)} result (${String(bytes)} bytes), over the ${formatBytes(this.maxResultBytes)} limit (${String(this.maxResultBytes)} bytes)`,
      },
    };
  }
}

/**
 * The smallest of the server's `timeout.execution` (milliseconds), the
 * request's `timeoutMs` and {@link DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS}.
 */
export function mcpBridgeCallTimeoutMs(
  serverExecutionMs: number | undefined,
  requestTimeoutMs: number | undefined,
): number {
  return Math.min(
    serverExecutionMs ?? DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
    requestTimeoutMs ?? DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
    DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
  );
}

function outcomeLabel(response: McpBridgeCallResponse): string {
  return response.status === "unavailable"
    ? `unavailable:${response.reason}`
    : response.status;
}
