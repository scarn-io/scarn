import type { HealthCheckReport } from "./run-health-checks";
import type { McpHandshakeReport } from "./run-work-dry-run-health-checks";

/**
 * True only when container + OpenCode health are both fine, every MCP server
 * passed its handshake, and every declared health check {@link
 * HealthCheckReport.outcome} passed or was explicitly deferred to real runs.
 * Other skipped checks still fail the dry run.
 */
export function computeDryRunOk(input: {
  containerHealthy: boolean | undefined;
  opencodeHealthy: boolean;
  mcpServers: McpHandshakeReport[];
  healthChecks: HealthCheckReport[];
}): boolean {
  return (
    (input.containerHealthy ?? true) &&
    input.opencodeHealthy &&
    input.mcpServers.every((server) => server.healthy) &&
    input.healthChecks.every(
      ({ outcome }) =>
        outcome.kind === "passed" ||
        (outcome.kind === "skipped" && outcome.reason === "real-runs-only"),
    )
  );
}
