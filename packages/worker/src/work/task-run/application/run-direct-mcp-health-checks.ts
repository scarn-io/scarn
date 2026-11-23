/**
 * The health check runner for a step with no agent (ADR 0016 decision 8): a
 * code step's `defineMcp` checks are plain MCP tool calls made from the
 * worker through the run's connection pool, so they also warm the
 * connections `fn` reuses afterwards.
 *
 * Each check calls `check.tool` with `check.args` on server `check.mcp`,
 * bounded by the check's `timeoutSeconds`. `ok` passes; `tool_error`,
 * `unavailable` and `timeout` fail. A call aborted by the run is `skipped`:
 * the run is ending anyway. Ordering (`required` before `warn`, lanes,
 * `serialGroup`) is shared with the OpenCode runner through
 * `health-check-scheduling.ts`, and the report shape is the same.
 *
 * Only `tool` checks with `mcp` set can reach here; validation rejects any
 * other check on a step without an agent, so one is an internal error.
 */
import type { HealthCheck } from "@scarn/sdk/health-checks";
import type { AnyJsonObject } from "../../../common/contracts/json";
import type { McpConnectionPool } from "./mcp-connection-pool";
import type { McpContentBlock, McpToolCallOutcome } from "./mcp-tool-caller";
import { scheduleHealthChecks } from "./health-check-scheduling";
import {
  buildReport,
  resolveHealthCheckToolId,
  type HealthCheckOutcome,
  type HealthCheckReport,
} from "./run-health-checks";

const TOOL_ERROR_DETAIL_MAX_CHARS = 2000;

export type RunDirectMcpHealthChecksInput = {
  /** The run's pool; the same one the step's own MCP calls go through. */
  pool: Pick<McpConnectionPool, "call">;
  /** In declaration order. */
  healthChecks: readonly HealthCheck[];
  /** The run's signal; aborting it skips checks that haven't finished. */
  signal: AbortSignal;
};

export async function runDirectMcpHealthChecks(
  input: RunDirectMcpHealthChecksInput,
): Promise<HealthCheckReport[]> {
  const results = await scheduleHealthChecks(input.healthChecks, (check) =>
    runOneDirectCheck(check, input),
  );
  return results.map(({ check, outcome }) =>
    buildReport(check, resolveHealthCheckToolId(check), outcome),
  );
}

async function runOneDirectCheck(
  check: HealthCheck,
  input: RunDirectMcpHealthChecksInput,
): Promise<HealthCheckOutcome> {
  if (check.kind !== "tool" || !check.mcp) {
    throw new Error(
      `Health check "${check.name ?? resolveHealthCheckToolId(check)}" can't run without an agent: only MCP tool checks (kind "tool" with "mcp" set) can`,
    );
  }
  const timeoutMs = check.timeoutSeconds * 1000;
  const outcome = await input.pool.call(check.mcp, {
    tool: check.tool,
    args: (check.args ?? {}) as AnyJsonObject,
    timeoutMs,
    signal: input.signal,
  });
  return toHealthCheckOutcome(outcome, timeoutMs);
}

function toHealthCheckOutcome(
  outcome: McpToolCallOutcome,
  timeoutMs: number,
): HealthCheckOutcome {
  switch (outcome.status) {
    case "ok":
      return { kind: "passed" };
    case "tool_error":
      return {
        kind: "failed",
        reason: "tool-error",
        detail: toolErrorDetail(outcome.content),
      };
    case "unavailable":
      return {
        kind: "failed",
        reason: "unavailable",
        detail: `${outcome.reason}: ${outcome.detail}`,
      };
    case "timeout":
      return {
        kind: "failed",
        reason: "timeout",
        detail: `The tool call did not finish within ${String(timeoutMs)}ms.`,
      };
    case "aborted":
      return { kind: "skipped" };
  }
}

function toolErrorDetail(content: McpContentBlock[]): string {
  const text = content
    .flatMap((block) =>
      block.type === "text" && typeof block["text"] === "string"
        ? [block["text"]]
        : [],
    )
    .join("\n")
    .trim();
  if (text.length === 0) {
    return "The tool returned an error with no text content.";
  }
  return text.length > TOOL_ERROR_DETAIL_MAX_CHARS
    ? `${text.slice(0, TOOL_ERROR_DETAIL_MAX_CHARS)}…`
    : text;
}
