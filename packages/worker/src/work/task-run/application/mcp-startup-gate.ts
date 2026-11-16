/**
 * The MCP startup gate (decision 10): before the first prompt, every connector
 * and every step `mcps` server must report `connected`. Runs whether or not
 * the step declares `healthChecks`; declared checks run after it. Servers the
 * repo's own OpenCode config contributes (which Scarn didn't add, and may
 * legitimately be disabled) are not part of the gate.
 */
import type {
  OpencodeServerHandle,
  ProjectWorkLogger,
} from "../contracts/process-project-work-types";
import { ConnectorUnavailableError } from "./connector-unavailable-error";
import { pollMcpStatus, type McpHandshakeReport } from "./poll-mcp-status";

export type McpStartupGateOptions = {
  /** Defaults to `pollMcpStatus`'s 60s window. */
  windowMs?: number | undefined;
  intervalMs?: number | undefined;
  /** Replaces the real `pollMcpStatus` (tests without a live OpenCode). */
  poll?: typeof pollMcpStatus | undefined;
};

/** The servers the gate waits on: the step's `mcps` keys plus its connector ids. */
export function mcpStartupGateServers(input: {
  stepMcpServerKeys: readonly string[];
  connectors: readonly string[];
}): string[] {
  return [...new Set([...input.stepMcpServerKeys, ...input.connectors])];
}

/**
 * Polls OpenCode until each of `expectedServers` settles and reports one
 * entry per expected server. Returns `[]` without polling when there are
 * none.
 */
export async function checkMcpStartupGate(
  server: OpencodeServerHandle,
  expectedServers: readonly string[],
  options?: McpStartupGateOptions,
): Promise<McpHandshakeReport[]> {
  if (expectedServers.length === 0) {
    return [];
  }
  return (options?.poll ?? pollMcpStatus)(server, {
    expectedServers,
    windowMs: options?.windowMs,
    intervalMs: options?.intervalMs,
  });
}

/**
 * {@link checkMcpStartupGate}, throwing {@link ConnectorUnavailableError}
 * listing every server that isn't `connected`. Logs the gate's result either
 * way.
 */
export async function runMcpStartupGateOrThrow(input: {
  server: OpencodeServerHandle;
  expectedServers: readonly string[];
  options?: McpStartupGateOptions | undefined;
  logger: ProjectWorkLogger;
  taskRunId: string;
}): Promise<McpHandshakeReport[]> {
  if (input.expectedServers.length === 0) {
    return [];
  }
  input.logger.log("step", "Waiting for MCP servers to connect", {
    taskRunId: input.taskRunId,
    expectedServers: input.expectedServers,
  });
  const reports = await checkMcpStartupGate(
    input.server,
    input.expectedServers,
    input.options,
  );
  input.logger.log("step", "MCP startup gate completed", {
    taskRunId: input.taskRunId,
    reports,
  });
  const failing = reports.filter((report) => !report.healthy);
  if (failing.length > 0) {
    throw new ConnectorUnavailableError(failing);
  }
  return reports;
}
