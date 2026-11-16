import type { McpServer } from "@opencode/client";
import { logWorkError } from "./work-logger";
import {
  createScarnOpencodeClient,
  opencodeLocation,
} from "../infra/opencode-client";
import type { OpencodeServerHandle } from "../../../runtime/runtime-service/infra/opencode-server-contract";

/**
 * How long to keep polling `client.mcp.list()` before settling on a report.
 * Sized for cold `uvx`/`npx` installs, which routinely take 5–15s to connect.
 */
export const MCP_STATUS_POLL_WINDOW_MS = 60_000;
const MCP_STATUS_POLL_INTERVAL_MS = 500;

/**
 * An MCP server's connection status as reported by OpenCode's `GET /api/mcp`,
 * plus `missing`: an expected server OpenCode never listed by the end of the
 * poll window.
 */
export type McpConnectionStatus = McpServer["status"]["status"] | "missing";

/**
 * One server's result in the MCP startup gate (`mcp-startup-gate.ts`): the
 * status `client.mcp.list()` reported for it and whether it passes. The
 * dry-run report's per-server shape ({@link WorkDryRunReport.mcpServers} in
 * `run-work-dry-run.ts`) is this same gate result, so a dry run shows exactly
 * what a real run would be stopped by. A server's declared health checks are
 * reported separately, in the report's top-level `healthChecks` array.
 */
export type McpHandshakeReport = {
  name: string;
  status: McpConnectionStatus;
  error?: string | undefined;
  /** Only `connected` passes; `disabled` does not count (decision 10). */
  healthy: boolean;
};

function toReport(entry: McpServer): McpHandshakeReport {
  const { status } = entry;
  return {
    name: entry.name,
    status: status.status,
    error: "error" in status ? status.error : undefined,
    healthy: status.status === "connected",
  };
}

function missingReport(name: string): McpHandshakeReport {
  return {
    name,
    status: "missing",
    error: "OpenCode never registered this server",
    healthy: false,
  };
}

/**
 * Poll `client.mcp.list()` for a window rather than trusting a single read: a
 * slow-starting MCP server (e.g. an `npx`-installed one) can race a read
 * taken immediately after OpenCode reports healthy. Stops early once no
 * considered server is still `pending` and two consecutive polls agree,
 * otherwise returns whatever the last poll saw when the window elapses. A
 * server stuck in `pending` across consecutive polls is still connecting,
 * not settled. Likewise, a server named in `expectedServers` that is not
 * listed yet has not been registered: right after boot OpenCode can report
 * an empty list for a moment, and two empty reads must not count as settled.
 *
 * With `expectedServers`, the report covers exactly those servers — anything
 * else OpenCode lists (e.g. a repo server Scarn didn't add) is ignored, and
 * an expected server still unlisted at the end is reported as `missing`.
 * Without it, every listed server is reported.
 */
export async function pollMcpStatus(
  server: OpencodeServerHandle,
  options?: {
    windowMs?: number | undefined;
    intervalMs?: number | undefined;
    expectedServers?: readonly string[] | undefined;
  },
): Promise<McpHandshakeReport[]> {
  const client = createScarnOpencodeClient(server);
  const windowMs = options?.windowMs ?? MCP_STATUS_POLL_WINDOW_MS;
  const intervalMs = options?.intervalMs ?? MCP_STATUS_POLL_INTERVAL_MS;
  const expectedServers = options?.expectedServers;
  const deadline = Date.now() + windowMs;
  let previous: McpServer[] | null = null;

  for (;;) {
    let listed: McpServer[] = [];
    try {
      const response = await client.mcp.list({
        location: opencodeLocation(server),
      });
      listed = response.data;
    } catch (error) {
      logWorkError("mcp-status", "Failed to read MCP status", {
        agentBaseUrl: server.baseUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const current = expectedServers
      ? listed.filter((entry) => expectedServers.includes(entry.name))
      : listed;

    const settled =
      current.every(({ status }) => status.status !== "pending") &&
      (expectedServers ?? []).every((name) =>
        current.some((entry) => entry.name === name),
      );
    const stable =
      settled &&
      previous !== null &&
      JSON.stringify(previous) === JSON.stringify(current);
    const timedOut = Date.now() >= deadline;

    if (stable || timedOut) {
      const missing = (expectedServers ?? [])
        .filter((name) => !current.some((entry) => entry.name === name))
        .map(missingReport);
      return [...current.map(toReport), ...missing].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    }

    previous = current;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
}
