import type { HealthCheck } from "@scarn/sdk/health-checks";
import type { OpenCodeMcpServers } from "../../../common/contracts/opencode-mcp";
import { stepConnectionAuthEntries } from "./resolve-step-env";
import {
  partitionManagedMcpHealthChecks,
  probeManagedMcpConnections,
  type ManagedMcpProbeClient,
} from "./probe-managed-mcp-connections";
import type { McpHandshakeReport } from "./poll-mcp-status";
import type { HealthCheckReport } from "./run-health-checks";
import { computeDryRunOk } from "./compute-dry-run-ok";
import type { WorkDryRunReport, WorkDryRunScope } from "./run-work-dry-run";

/** Probes managed startup without a claim and isolates checks that require a runtime. */
export async function prepareWorkDryRunHealthChecks(input: {
  client: ManagedMcpProbeClient;
  projectId: string;
  opencodeMcpJson: OpenCodeMcpServers | null | undefined;
  healthChecks: readonly HealthCheck[];
}) {
  const entries = stepConnectionAuthEntries(input.opencodeMcpJson);
  const aliases = new Set(entries.map((entry) => entry.key));
  const opencodeMcpJson = input.opencodeMcpJson
    ? Object.fromEntries(
        Object.entries(input.opencodeMcpJson).filter(
          ([, server]) => server.type === "local" || !server.auth,
        ),
      )
    : null;
  const { runnableChecks, skippedChecks } = partitionManagedMcpHealthChecks({
    entries,
    healthChecks: input.healthChecks,
  });
  const managed = await probeManagedMcpConnections({
    client: input.client,
    projectId: input.projectId,
    entries,
  });

  return {
    opencodeMcpJson,
    runnableChecks,
    needsRuntime:
      entries.length === 0 ||
      runnableChecks.length > 0 ||
      Object.values(opencodeMcpJson ?? {}).some(
        (server) => server.disabled !== true,
      ),
    mergeReports(runtime: {
      mcpServers: McpHandshakeReport[];
      healthChecks: HealthCheckReport[];
    }) {
      const byName = new Map(
        [...runtime.mcpServers, ...managed.mcpServers].map((server) => [
          server.name,
          server,
        ]),
      );
      const authored = Object.keys(input.opencodeMcpJson ?? {});
      const names = new Set([...authored, ...byName.keys()]);
      const runnable = [...runtime.healthChecks];
      const skipped = [...skippedChecks];
      return {
        mcpServers: [...names].flatMap((name) => {
          const server = byName.get(name);
          return server ? [server] : [];
        }),
        healthChecks: input.healthChecks.flatMap((check) => {
          const result =
            check.kind === "tool" && check.mcp && aliases.has(check.mcp)
              ? skipped.shift()
              : runnable.shift();
          return result ? [result] : [];
        }),
      };
    },
  };
}

/** A managed-only rehearsal reports real server-side startup, not a skipped launch. */
export function managedOnlyWorkDryRunReport(input: {
  scope: WorkDryRunScope;
  mcpServers: McpHandshakeReport[];
  healthChecks: HealthCheckReport[];
  note: { baseBranchNote?: string };
}): WorkDryRunReport {
  return {
    ok: computeDryRunOk({
      containerHealthy: undefined,
      opencodeHealthy: true,
      mcpServers: input.mcpServers,
      healthChecks: input.healthChecks,
    }),
    scope: input.scope,
    workspacePath: null,
    runtimeContainerId: null,
    agentBaseUrl: null,
    kept: false,
    containerHealth: null,
    opencodeHealth: null,
    providerCredentials: { ok: true, detail: "not checked" },
    mcpServers: input.mcpServers,
    healthChecks: input.healthChecks,
    secrets: [],
    ...input.note,
  };
}
