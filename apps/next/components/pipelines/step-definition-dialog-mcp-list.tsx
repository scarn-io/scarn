"use client";

import { useEffect, useState } from "react";
import NextLink from "next/link";
import type {
  HealthChecks,
  ManagedConnectionContract,
  OpenCodeMcpServers,
} from "@scarn/api/frontend-contracts";
import { Chip, Link, Paper, Stack, Typography } from "@mui/material";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { useProjectPath } from "@/components/project-route-context";
import { managedConnectionStatusLine } from "@/components/settings/project-mcp-connection-messages";

type OpenCodeMcpServerConfig = OpenCodeMcpServers[string];
type ConnectionAuth = NonNullable<
  Extract<OpenCodeMcpServerConfig, { type: "ref" | "remote" }>["auth"]
>;
type ConnectionsStatus =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "loaded"; connections: ManagedConnectionContract[] };

const monoSx = {
  fontFamily: "monospace",
  fontSize: 12,
  wordBreak: "break-all",
} as const;

function serverTarget(key: string, server: OpenCodeMcpServerConfig): string {
  if (server.type === "ref") return server.name ?? key;
  if (server.type === "local") return server.command.join(" ");
  return server.url;
}

function serverAuth(server: OpenCodeMcpServerConfig): ConnectionAuth | null {
  return server.type === "local" ? null : (server.auth ?? null);
}

function serverVars(
  server: OpenCodeMcpServerConfig,
): [string, Record<string, string>] | null {
  if (serverAuth(server)) return null;
  if (server.type === "local" && server.environment)
    return ["Environment", server.environment];
  if (server.type === "remote" && server.headers)
    return ["Headers", server.headers];
  return null;
}

/**
 * Loads the project's managed connections while `enabled`. A failure or a
 * forbidden response settles on `failed`; it never blocks the dialog.
 */
function useProjectConnections(
  projectId: string,
  enabled: boolean,
): ConnectionsStatus {
  const [status, setStatus] = useState<ConnectionsStatus>({ kind: "loading" });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const settle = (next: ConnectionsStatus) => {
      if (!cancelled) setStatus(next);
    };
    getBrowserScarnApiClient()
      .api.projects({ projectId })
      ["mcp-connections"].get()
      .then(({ data }) => {
        settle(
          Array.isArray(data)
            ? { kind: "loaded", connections: data }
            : { kind: "failed" },
        );
      })
      .catch(() => {
        settle({ kind: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, enabled]);
  return status;
}

function ConnectionAuthStatus({
  auth,
  status,
}: {
  auth: ConnectionAuth;
  status: ConnectionsStatus;
}) {
  const projectPath = useProjectPath();
  const connection =
    status.kind === "loaded"
      ? (status.connections.find((c) => c.name === auth.connection) ?? null)
      : null;
  return (
    <Stack spacing={0.25} data-testid="mcp-server-connection-auth">
      <Typography variant="body2">
        Authenticated by the project&apos;s{" "}
        {connection?.label ?? auth.connection} connection
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {status.kind === "loading"
          ? "Loading the connection's status…"
          : status.kind === "failed"
            ? "Couldn't load the connection's status"
            : managedConnectionStatusLine(connection)}
      </Typography>
      {connection?.state === "ready_with_pending_reconnect" ? (
        <Typography variant="body2" color="text.secondary">
          A reconnect is waiting for confirmation; this account stays connected
          until then.
        </Typography>
      ) : null}
      <Link component={NextLink} href={projectPath("settings")} variant="body2">
        Manage in project settings
      </Link>
    </Stack>
  );
}

function McpServerCard({
  serverKey,
  server,
  checks,
  connections,
}: {
  serverKey: string;
  server: OpenCodeMcpServerConfig;
  checks: HealthChecks;
  connections: ConnectionsStatus;
}) {
  const vars = serverVars(server);
  const auth = serverAuth(server);
  return (
    <Paper
      variant="outlined"
      sx={{ p: 2 }}
      data-testid={`mcp-server-${serverKey}`}
    >
      <Stack spacing={1}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="body2" fontWeight={500} sx={{ flex: 1 }}>
            {serverKey}
          </Typography>
          <Chip
            label={server.type}
            size="small"
            variant="outlined"
            color={
              server.type === "remote"
                ? "primary"
                : server.type === "ref"
                  ? "secondary"
                  : "default"
            }
            sx={{ fontFamily: "monospace", fontSize: 11 }}
          />
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={monoSx}>
          {serverTarget(serverKey, server)}
        </Typography>
        {auth ? (
          <ConnectionAuthStatus auth={auth} status={connections} />
        ) : null}
        {vars ? (
          <Stack spacing={0.25}>
            <Typography variant="caption" color="text.secondary">
              {vars[0]}
            </Typography>
            {Object.entries(vars[1]).map(([name, value]) => (
              <Typography key={name} variant="body2" sx={monoSx}>
                {name}: {value}
              </Typography>
            ))}
          </Stack>
        ) : null}
        {checks.length > 0 ? (
          <Stack spacing={0.5}>
            <Typography variant="caption" color="text.secondary">
              Health checks
            </Typography>
            {checks.map((check, i) => (
              <Stack
                key={check.name ?? i}
                direction="row"
                alignItems="center"
                spacing={1}
              >
                <Typography variant="body2" sx={{ ...monoSx, flex: 1 }}>
                  {check.name ?? "(unnamed)"}
                  {check.kind === "tool" ? ` → ${check.tool}` : ""}
                </Typography>
                <Chip
                  label={check.severity}
                  size="small"
                  variant="outlined"
                  color={check.severity === "warn" ? "warning" : "default"}
                />
              </Stack>
            ))}
          </Stack>
        ) : null}
      </Stack>
    </Paper>
  );
}

export function McpServerList({
  projectId,
  servers,
  healthChecks,
}: {
  projectId: string;
  servers: OpenCodeMcpServers | null;
  healthChecks: HealthChecks | null;
}) {
  const entries = Object.entries(servers ?? {});
  const connections = useProjectConnections(
    projectId,
    entries.some(([, server]) => serverAuth(server) !== null),
  );
  return (
    <>
      <Typography variant="body2" color="text.secondary">
        MCP servers are defined in code with <code>defineMcp</code>.
      </Typography>
      {entries.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No MCP servers.
        </Typography>
      ) : (
        entries.map(([key, server]) => (
          <McpServerCard
            key={key}
            serverKey={key}
            server={server}
            connections={connections}
            checks={(healthChecks ?? []).filter(
              (c) => c.kind === "tool" && c.mcp === key,
            )}
          />
        ))
      )}
    </>
  );
}
