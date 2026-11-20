import {
  normalizeMcpResourceUrl,
  type ManagedConnectionName,
} from "@scarn/sdk/managed-connections";
import type {
  ManagedConnectionSummary,
  ManagedConnectionsPorts,
} from "./design-managed-connections";
import { CliError } from "./cli-error";
import type { PushedMcpServerUrl } from "./push-mcp-server-urls";

const MCP_CONNECTION_AUTH_INVALID = "SCARN_MCP_CONNECTION_AUTH_INVALID";

/**
 * After `pipelines push`, checks the pushed steps' MCP servers against the
 * project's managed connections (ADR 0013 decisions 11 and 40):
 *
 * - `status`: one line per connection the steps reference, with its state.
 *   Publishing never needs the connection, so these are warnings.
 * - `warnings`: a remote without `auth` whose URL is a connection's.
 * - `problems`: an `auth` entry whose URL isn't its connection's. Launch
 *   registration refuses such a run, so the command fails after the push.
 *
 * A connection that doesn't exist yet reports nothing beyond its status:
 * pushing before connecting is allowed. Connections are shown by label, with
 * the name where `auth` refers to it; only labels, names and URLs reach the
 * output.
 */

export type PushConnectionStatusPorts = Pick<
  ManagedConnectionsPorts,
  "listManagedConnections"
>;

export type PushConnectionReport = {
  status: string[];
  warnings: string[];
  problems: string[];
};

const authSnippet = (name: ManagedConnectionName) =>
  `auth: { connection: "${name}" }`;

const describeServer = (server: PushedMcpServerUrl) =>
  `Step "${server.step}" MCP server "${server.key}"`;

export async function pushConnectionReport(input: {
  baseUrl: string;
  projectId: string;
  servers: readonly PushedMcpServerUrl[];
  ports: PushConnectionStatusPorts;
}): Promise<PushConnectionReport> {
  const names = [
    ...new Set(input.servers.flatMap(({ connection }) => connection ?? [])),
  ];
  const unauthed = input.servers.filter(
    (server) => server.connection === null && server.url !== null,
  );
  const report: PushConnectionReport = {
    status: [],
    warnings: [],
    problems: [],
  };
  if (names.length === 0 && unauthed.length === 0) return report;

  const listed = await input.ports
    .listManagedConnections({
      baseUrl: input.baseUrl,
      projectId: input.projectId,
    })
    .catch(() => ({ ok: false as const }));
  if (!listed.ok) {
    report.status.push(
      names.length > 0
        ? `Couldn't check the status of the referenced connections (${names.join(", ")}); the push still succeeded.`
        : "Couldn't check the pushed MCP servers against the project's connections; the push still succeeded.",
    );
    return report;
  }

  const byName = new Map<string, ManagedConnectionSummary>(
    listed.connections.map((connection) => [connection.name, connection]),
  );
  const byResource = new Map<string, ManagedConnectionSummary>(
    listed.connections.flatMap((connection) => {
      const resource = normalizeMcpResourceUrl(connection.resource);
      return resource === null ? [] : [[resource, connection] as const];
    }),
  );

  report.status = names.map((name) => {
    const connection = byName.get(name);
    return `${statusSubject(name, connection)}: ${describeConnection(connection)}`;
  });

  for (const server of input.servers) {
    if (server.connection === null || server.url === null) continue;
    const connection = byName.get(server.connection);
    if (connection === undefined) continue;
    const expected = normalizeMcpResourceUrl(connection.resource);
    if (normalizeMcpResourceUrl(server.url) === expected) continue;
    report.problems.push(
      `${describeServer(server)} uses the project's ${connection.label} connection (${authSnippet(server.connection)}), ` +
        `but its URL is not the connection's. Point it at ${connection.resource}.`,
    );
  }

  for (const server of unauthed) {
    const resource = normalizeMcpResourceUrl(server.url ?? "");
    const connection = resource === null ? undefined : byResource.get(resource);
    if (connection === undefined) continue;
    report.warnings.push(
      `${describeServer(server)} points at the project's ${connection.label} connection (${connection.resource}) but has no auth, ` +
        `so it won't use the connection's credentials. Add ${authSnippet(connection.name)} to it.`,
    );
  }

  return report;
}

/**
 * Fails the command (exit 1, `push_connection_url_mismatch`) when the report
 * has problems. The push has already been published by then; the message
 * says so and lists every server that will fail at launch.
 */
export function assertNoPushConnectionProblems(
  report: Pick<PushConnectionReport, "problems">,
): void {
  if (report.problems.length === 0) return;
  throw new CliError(
    "push_connection_url_mismatch",
    [
      `Pushed, but these MCP servers will fail at launch with ${MCP_CONNECTION_AUTH_INVALID}:`,
      ...report.problems.map((problem) => `  ${problem}`),
      "Fix them and push again.",
    ].join("\n"),
  );
}

/** The connection's label and the name `auth` uses, or just the name when the project has no such connection. */
function statusSubject(
  name: string,
  connection: ManagedConnectionSummary | undefined,
): string {
  return connection === undefined ? name : `${connection.label} ("${name}")`;
}

function describeConnection(
  connection: ManagedConnectionSummary | undefined,
): string {
  if (connection === undefined || connection.state === "disconnected") {
    return "not connected — a project admin can connect it in project settings";
  }
  switch (connection.state) {
    case "ready":
      return connectedAs(connection);
    case "ready_with_pending_reconnect":
      return `${connectedAs(connection)}; a reconnect is pending — a project admin can finish it in project settings`;
    case "reconnect_required":
      return "reconnect required — a project admin can reconnect it in project settings";
    default:
      return connection.state;
  }
}

function connectedAs(connection: ManagedConnectionSummary): string {
  const names = [
    connection.account?.userName,
    connection.account?.workspaceName,
  ].filter((name): name is string => typeof name === "string" && name !== "");
  return names.length > 0 ? `connected as ${names.join(" / ")}` : "connected";
}
