import type { createScarnClient } from "@scarn/sdk";
import type { HealthCheck } from "@scarn/sdk/health-checks";
import type { StepConnectionAuthEntry } from "./resolve-step-env";
import type { McpHandshakeReport } from "./poll-mcp-status";
import {
  resolveHealthCheckToolId,
  type HealthCheckReport,
} from "./run-health-checks";

export type ManagedMcpProbeClient = {
  connections: Pick<
    ReturnType<typeof createScarnClient>["connections"],
    "listManagedMcpConnections" | "listManagedMcpConnectionTools"
  >;
};

export type ManagedMcpProbeReport = {
  mcpServers: McpHandshakeReport[];
  /** Bare provider tool names, keyed by the authored MCP alias. Failed probes have no inventory. */
  toolNamesByServer: ReadonlyMap<string, readonly string[]>;
};

/** Server-side startup gate for dry runs without a claim; never launches or invokes an authored tool. */
export async function probeManagedMcpConnections(input: {
  client: ManagedMcpProbeClient;
  projectId: string;
  entries: readonly StepConnectionAuthEntry[];
}): Promise<ManagedMcpProbeReport> {
  const toolNamesByServer = new Map<string, readonly string[]>();
  if (input.entries.length === 0) return { mcpServers: [], toolNamesByServer };

  const unavailable = (entry: StepConnectionAuthEntry): McpHandshakeReport => ({
    name: entry.key,
    status: "failed",
    healthy: false,
    error: `The project's "${entry.connection}" connection is not serving. Reconnect it in project settings and try again.`,
  });

  try {
    const listed = await input.client.connections.listManagedMcpConnections({
      path: { projectId: input.projectId },
    });
    if (listed.error) {
      return { mcpServers: input.entries.map(unavailable), toolNamesByServer };
    }
    const byName = new Map(
      listed.data.map((connection) => [connection.name, connection]),
    );
    const probes = new Map<string, Promise<readonly string[] | null>>();
    const mcpServers = await Promise.all(
      input.entries.map(async (entry): Promise<McpHandshakeReport> => {
        const connection = byName.get(entry.connection);
        if (
          !connection ||
          (connection.state !== "ready" &&
            connection.state !== "ready_with_pending_reconnect")
        ) {
          return unavailable(entry);
        }
        let probe = probes.get(connection.id);
        if (!probe) {
          probe = (async () => {
            try {
              const result =
                await input.client.connections.listManagedMcpConnectionTools({
                  path: {
                    projectId: input.projectId,
                    connectionId: connection.id,
                  },
                });
              return result.error
                ? null
                : result.data.tools.map((tool) => tool.name);
            } catch {
              return null;
            }
          })();
          probes.set(connection.id, probe);
        }
        const names = await probe;
        if (names === null) return unavailable(entry);
        toolNamesByServer.set(entry.key, names);
        return { name: entry.key, status: "connected", healthy: true };
      }),
    );
    return { mcpServers, toolNamesByServer };
  } catch {
    return { mcpServers: input.entries.map(unavailable), toolNamesByServer };
  }
}

/** Separates auth tool checks from checks that still need the ordinary dry-run runtime. */
export function partitionManagedMcpHealthChecks(input: {
  entries: readonly StepConnectionAuthEntry[];
  healthChecks: readonly HealthCheck[];
}): { runnableChecks: HealthCheck[]; skippedChecks: HealthCheckReport[] } {
  const aliases = new Set(input.entries.map((entry) => entry.key));
  const runnableChecks: HealthCheck[] = [];
  const skippedChecks: HealthCheckReport[] = [];
  for (const check of input.healthChecks) {
    if (check.kind !== "tool" || !check.mcp || !aliases.has(check.mcp)) {
      runnableChecks.push(check);
      continue;
    }
    const resolvedId = resolveHealthCheckToolId(check);
    skippedChecks.push({
      name: check.name ?? resolvedId,
      resolvedId,
      severity: check.severity,
      kind: check.kind,
      outcome: { kind: "skipped", reason: "real-runs-only" },
    });
  }
  return { runnableChecks, skippedChecks };
}
