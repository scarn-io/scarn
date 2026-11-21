import {
  normalizeMcpResourceUrl,
  type ManagedConnectionName,
} from "@scarn/sdk/managed-connections";
import type {
  GetApiProjectsByProjectIdMcpConnectionsResponse,
  GetApiProjectsByProjectIdMcpConnectionsByConnectionIdToolsResponse,
} from "@scarn/sdk";
import type {
  DiscoveredMcpServer,
  ListedMcpTool,
  ManifestManagedConnection,
  ManifestServerConnection,
  McpServerAvailability,
} from "@scarn/worker";

/**
 * The design preflight's view of the project's managed MCP connections
 * (Decision 4): which repository servers are backed by one, and the tools
 * each connection offers, as listed centrally by the API. The CLI never
 * starts a connection's server, never runs an OAuth flow and never talks to
 * the provider itself. A connection that isn't ready is recorded as
 * unavailable with its state; nothing is silently started instead.
 *
 * Reasons are built from status codes and states only, never from a response
 * body, so nothing the API or provider sent besides display names and tool
 * metadata reaches the manifest.
 */

export type ManagedConnectionSummary =
  GetApiProjectsByProjectIdMcpConnectionsResponse[number];

export type ManagedConnectionTool =
  GetApiProjectsByProjectIdMcpConnectionsByConnectionIdToolsResponse["tools"][number];

/** An API call that did not succeed. `status` is null when nothing answered. */
export type ManagedConnectionsApiFailure = {
  ok: false;
  status: number | null;
  /** The 409's `meta.state` / `meta.reasonCode`, when present. */
  state?: string | undefined;
  reasonCode?: string | null | undefined;
  /** The 503's `Retry-After`, in seconds. */
  retryAfterSeconds?: number | undefined;
};

export interface ManagedConnectionsPorts {
  listManagedConnections(input: {
    baseUrl: string;
    projectId: string;
  }): Promise<
    | { ok: true; connections: readonly ManagedConnectionSummary[] }
    | ManagedConnectionsApiFailure
  >;
  listManagedConnectionTools(input: {
    baseUrl: string;
    projectId: string;
    connectionId: string;
  }): Promise<
    | { ok: true; tools: readonly ManagedConnectionTool[] }
    | ManagedConnectionsApiFailure
  >;
}

const SERVING_STATES: ReadonlySet<string> = new Set([
  "ready",
  "ready_with_pending_reconnect",
]);

const DEFAULT_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 3_000;

type ConnectionListing = {
  availability: McpServerAvailability;
  tools: ListedMcpTool[];
};

export type ResolvedManagedConnections = {
  /** Absent when the project's connections could not be listed. */
  connections: ManifestManagedConnection[] | undefined;
  /** Why the list call failed, when it did. */
  listFailure: string | undefined;
  /**
   * The listing for a repository server whose URL is one of the listed
   * connections' resource, or null when no listed connection backs it.
   */
  connectionForServer(
    server: DiscoveredMcpServer,
  ): ConnectionListingWithConnection | null;
  /**
   * The listing for the connection named `name`, as `auth: { connection }`
   * names it; unavailable when the project has no such connection or its
   * connections could not be listed.
   */
  connectionByName(
    name: ManagedConnectionName,
  ): ConnectionListingWithConnection;
};

type ConnectionListingWithConnection = ConnectionListing & {
  connection: ManifestServerConnection;
};

function unlistedConnection(
  name: ManagedConnectionName,
  reason: string,
): ConnectionListingWithConnection {
  return {
    connection: { name, label: name, state: null, reasonCode: null },
    ...unavailable(reason),
  };
}

export async function resolveManagedConnections(input: {
  baseUrl: string;
  projectId: string;
  ports: ManagedConnectionsPorts;
}): Promise<ResolvedManagedConnections> {
  const listed = await input.ports
    .listManagedConnections({
      baseUrl: input.baseUrl,
      projectId: input.projectId,
    })
    .catch((): ManagedConnectionsApiFailure => ({ ok: false, status: null }));

  if (!listed.ok) {
    const listFailure = `couldn't list the project's connections (${describeStatus(listed.status)})`;
    return {
      connections: undefined,
      listFailure,
      connectionForServer: () => null,
      connectionByName: (name) => unlistedConnection(name, listFailure),
    };
  }

  const connections = await Promise.all(
    listed.connections.map((summary) =>
      listConnectionTools({ ...input, connection: summary }).then(
        (listing) => ({ summary, listing }),
      ),
    ),
  );
  const byResource = new Map(
    connections.flatMap((entry) => {
      const resource = normalizeMcpResourceUrl(entry.summary.resource);
      return resource === null ? [] : [[resource, entry] as const];
    }),
  );

  return {
    connections: connections.map(({ summary, listing }) => ({
      name: summary.name,
      label: summary.label,
      url: summary.resource,
      state: summary.state,
      reasonCode: summary.reasonCode,
      account:
        summary.account === null
          ? null
          : {
              userName: summary.account.userName,
              workspaceName: summary.account.workspaceName,
            },
      availability: listing.availability,
      tools: listing.tools,
    })),
    listFailure: undefined,
    connectionForServer: (server) => {
      if (server.config.type !== "remote") return null;
      const resource = normalizeMcpResourceUrl(server.config.url);
      const match = resource === null ? undefined : byResource.get(resource);
      return match === undefined ? null : withConnection(match);
    },
    connectionByName: (name) => {
      const match = connections.find((entry) => entry.summary.name === name);
      return match === undefined
        ? unlistedConnection(
            name,
            `the project has no connection named "${name}"`,
          )
        : withConnection(match);
    },
  };
}

function withConnection(entry: {
  summary: ManagedConnectionSummary;
  listing: ConnectionListing;
}): ConnectionListingWithConnection {
  return {
    connection: {
      name: entry.summary.name,
      label: entry.summary.label,
      state: entry.summary.state,
      reasonCode: entry.summary.reasonCode,
    },
    ...entry.listing,
  };
}

async function listConnectionTools(input: {
  baseUrl: string;
  projectId: string;
  connection: ManagedConnectionSummary;
  ports: ManagedConnectionsPorts;
}): Promise<ConnectionListing> {
  const { connection } = input;
  if (connection.state === "disconnected") {
    return unavailable(`the project isn't connected to ${connection.label}`);
  }
  if (!SERVING_STATES.has(connection.state)) {
    return unavailable(notReadyReason(connection.state, connection.reasonCode));
  }

  const call = () =>
    input.ports
      .listManagedConnectionTools({
        baseUrl: input.baseUrl,
        projectId: input.projectId,
        connectionId: connection.id,
      })
      .catch((): ManagedConnectionsApiFailure => ({ ok: false, status: null }));

  let result = await call();
  if (!result.ok && result.status === 503) {
    await wait(retryAfterMs(result.retryAfterSeconds));
    result = await call();
  }
  if (result.ok) {
    return {
      availability: { status: "available" },
      tools: result.tools.map(toListedTool),
    };
  }

  switch (result.status) {
    case 403:
      return unavailable("you can't list this connection's tools");
    case 409:
      return unavailable(
        notReadyReason(
          result.state ?? connection.state,
          result.reasonCode === undefined
            ? connection.reasonCode
            : result.reasonCode,
        ),
      );
    default:
      return {
        availability: {
          status: "failed",
          reason: `couldn't list the connection's tools (${describeStatus(result.status)})`,
        },
        tools: [],
      };
  }
}

function unavailable(reason: string): ConnectionListing {
  return { availability: { status: "unavailable", reason }, tools: [] };
}

function notReadyReason(state: string, reasonCode: string | null): string {
  return reasonCode === null
    ? `the connection is ${state}`
    : `the connection is ${state} (${reasonCode})`;
}

function describeStatus(status: number | null): string {
  return status === null ? "no response" : `HTTP ${String(status)}`;
}

function retryAfterMs(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return DEFAULT_RETRY_AFTER_MS;
  }
  return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toListedTool(tool: ManagedConnectionTool): ListedMcpTool {
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    inputSchema: tool.inputSchema as ListedMcpTool["inputSchema"],
    ...(tool.outputSchema === undefined
      ? {}
      : {
          outputSchema: tool.outputSchema as NonNullable<
            ListedMcpTool["outputSchema"]
          >,
        }),
    ...(tool.readOnlyHint === undefined
      ? {}
      : { readOnlyHint: tool.readOnlyHint }),
  };
}
