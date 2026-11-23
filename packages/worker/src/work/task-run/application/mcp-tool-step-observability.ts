/**
 * What the `mcp_tool` branch reports about its call, and the size cap on the
 * result it hands on as findings.
 *
 * Task-log lines name the server, its transport, the tool, the call's
 * duration and outcome, the rendered args' keys and the result's content
 * block count. They never carry arg values, content, env values or headers.
 */
import type { AnyJsonValue } from "../../../common/contracts/json";
import type {
  OpenCodeMcpServers,
  ResolvedOpenCodeMcpServerConfig,
} from "../../../common/contracts/opencode-mcp";
import type { McpToolCallOutcome } from "./mcp-tool-caller";
import { McpToolStepError } from "./mcp-tool-step-error";
import { stepConnectionAuthEntries } from "./resolve-step-env";

/** The largest serialized findings an `mcp_tool` step may produce. */
export const MCP_TOOL_RESULT_MAX_BYTES = 1024 * 1024;

/** The call timeout when neither the server nor the caller sets one. */
export const DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS = 10 * 60 * 1_000;

/** `mcp: starting <server> (<transport>)`, logged when a server is first used. */
export function formatMcpServerStartingLine(
  serverKey: string,
  transport: McpServerTransportLabel,
): string {
  return `mcp: starting ${serverKey} (${transport})`;
}

/**
 * `mcp: <server>.<tool> called in <duration> (<outcome>)`, where `outcome`
 * is usually {@link mcpToolOutcomeLabel}.
 */
export function formatMcpToolCalledLine(
  serverKey: string,
  tool: string,
  durationMs: number,
  outcome: string,
): string {
  return `mcp: ${serverKey}.${tool} called in ${formatCallDuration(durationMs)} (${outcome})`;
}

export type McpServerTransportLabel = "local" | "remote" | "managed";

/**
 * `managed` when the step's authored entry for `serverKey` authenticates
 * through a managed connection (the launch rewrote it to the relay),
 * otherwise the resolved server's own type.
 */
export function mcpServerTransportLabel(
  serverKey: string,
  server: ResolvedOpenCodeMcpServerConfig,
  authoredServers: OpenCodeMcpServers | null | undefined,
): McpServerTransportLabel {
  if (server.type === "local") return "local";
  return stepConnectionAuthEntries(authoredServers).some(
    ({ key }) => key === serverKey,
  )
    ? "managed"
    : "remote";
}

/** `ok`, `tool_error`, `unavailable:<reason>`, `timeout` or `aborted`. */
export function mcpToolOutcomeLabel(outcome: McpToolCallOutcome): string {
  return outcome.status === "unavailable"
    ? `unavailable:${outcome.reason}`
    : outcome.status;
}

export function mcpToolOutcomeContentBlocks(
  outcome: McpToolCallOutcome,
): number | undefined {
  return outcome.status === "ok" || outcome.status === "tool_error"
    ? outcome.content.length
    : undefined;
}

export function formatCallDuration(durationMs: number): string {
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

/**
 * Throws `Scarn.McpOutputInvalid` when `findingsJson` serializes to more than
 * {@link MCP_TOOL_RESULT_MAX_BYTES} UTF-8 bytes.
 */
export function assertMcpToolResultWithinCap(
  findingsJson: AnyJsonValue,
  label: string,
  maxBytes: number = MCP_TOOL_RESULT_MAX_BYTES,
): void {
  const bytes = Buffer.byteLength(JSON.stringify(findingsJson), "utf8");
  if (bytes <= maxBytes) return;
  throw new McpToolStepError(
    "outputInvalid",
    `MCP tool ${label} returned a ${formatBytes(bytes)} result (${String(bytes)} bytes), over the ${formatBytes(maxBytes)} limit (${String(maxBytes)} bytes)`,
  );
}

/** `512 B`, `1.5 KiB` or `2 MiB`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${trimFixed(bytes / (1024 * 1024))} MiB`;
  }
  if (bytes >= 1024) return `${trimFixed(bytes / 1024)} KiB`;
  return `${String(bytes)} B`;
}

function trimFixed(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}
