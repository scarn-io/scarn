import path from "node:path";
import type { ManagedConnectionName } from "@scarn/sdk/managed-connections";
import type { AnyJsonObject } from "../../../common/contracts/json";
import type {
  DiscoveredAgentTools,
  DiscoveredMcpServer,
  InlineSecret,
  SkippedAgentTool,
} from "./discovered-agent-tools";

/**
 * `discovered-tools.json`: everything the pipeline designer needs to know
 * about the MCP servers and skills a repository defines, written by the
 * `pipelines design` preflight outside the repository at
 * `~/.scarn/projects/<owner>/<slug>/discovered-tools.json`.
 *
 * It carries names only. No env, header or argument value is ever written:
 * a server lists the variable names it reads, and its tools as the server
 * itself reported them.
 */

export const AGENT_TOOLS_MANIFEST_FILENAME = "discovered-tools.json";

/** Recorded in every manifest, so the designer never over-reads a listing. */
export const AGENT_TOOLS_MANIFEST_CAVEATS: readonly string[] = [
  "Tools were listed by starting each server on the user's machine. For a local server that proves the definition works, not that its command exists inside the devcontainer a workspace step runs in.",
  "A server whose URL is a managed connection's resource was not started locally: Scarn listed its tools through the project's connection.",
];

/** One tool as its server listed it. */
export type ListedMcpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: AnyJsonObject;
  /** The tool's declared structured-output JSON Schema, verbatim. */
  outputSchema?: AnyJsonObject;
  /** The `readOnlyHint` annotation, when the server sets one. */
  readOnlyHint?: boolean;
};

/** Whether the preflight could list a server's tools, and if not, why. */
export type McpServerAvailability =
  | { status: "available" }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; reason: string };

export type ManifestMcpServer = {
  name: string;
  /** Repo-relative file the definition came from. */
  source: string;
  transport: DiscoveredMcpServer["transport"];
  requiredEnv: string[];
  /** Literal credentials discovery dropped from the definition, by key. */
  inlineSecrets: Omit<InlineSecret, "inlineSecret">[];
  /** Lower-precedence files that also define this name. */
  shadowed: string[];
  /** `true` when the source file turns the server off. */
  disabledInSource?: true;
  /**
   * Set when the server's URL is a managed connection's resource. Such a
   * server is never started locally; its tools come from the connection.
   */
  connection?: ManifestServerConnection;
  /** Set when `scarn mcp pull` has locked this server's tools. */
  lock?: ManifestMcpToolLock;
  availability: McpServerAvailability;
  tools: ListedMcpTool[];
};

/**
 * One `mcp/<server>.lock.json` in the pipeline builder directory, written by
 * `scarn mcp pull` next to its generated `mcp/<server>.tools.ts` catalog.
 * `drift` compares the lock with the tools listed for this manifest:
 * `unknown` when the server wasn't listed (or isn't a repository server).
 */
export type ManifestMcpToolLock =
  | {
      status: "locked";
      server: string;
      /** Builder-directory-relative, e.g. `mcp/notion.lock.json`. */
      file: string;
      /** The generated catalog, e.g. `mcp/notion.tools.ts`. */
      catalogFile: string;
      hash: string;
      listedAt: string;
      toolNames: string[];
      drift: "matches" | "drifted" | "unknown";
    }
  | {
      status: "unreadable";
      file: string;
      reason: string;
    };

/**
 * The project's connection for a repository server's resource. `state` and
 * `reasonCode` are null when the project has no such connection, or when the
 * connections could not be listed.
 */
export type ManifestServerConnection = {
  name: ManagedConnectionName;
  label: string;
  state: string | null;
  reasonCode: string | null;
};

/** How one repository server's tools were listed, if they were. */
export type ManifestServerListing = {
  availability: McpServerAvailability;
  tools: ListedMcpTool[];
  connection?: ManifestServerConnection;
};

/** One of the project's managed connections, by display names only. */
export type ManifestManagedConnection = {
  name: ManagedConnectionName;
  label: string;
  /** The MCP resource an inline `remote` server with this `auth` must use. */
  url: string;
  state: string;
  reasonCode: string | null;
  account: { userName: string | null; workspaceName: string | null } | null;
  availability: McpServerAvailability;
  tools: ListedMcpTool[];
};

export type AgentToolsManifest = {
  version: 2;
  generatedAt: string;
  /** The `owner/slug` project this repository is linked to. */
  project: string;
  caveats: readonly string[];
  servers: ManifestMcpServer[];
  /**
   * The project's managed connections. Absent when they could not be listed;
   * empty when the project has none.
   */
  connections?: ManifestManagedConnection[];
  /**
   * Every MCP tool lock in the builder's `mcp/`, including locks for servers
   * that are not in the repository's MCP config (a `defineMcp` handle's own
   * server, or a managed connection). Absent when they could not be read.
   */
  locks?: ManifestMcpToolLock[];
  skills: { name: string; description: string; path: string }[];
  /** Entries discovery found but could not use, with the reason. */
  skipped: SkippedAgentTool[];
  /** Repo-relative MCP config files looked at, and whether each exists. */
  searched: { file: string; present: boolean }[];
};

/** Where the manifest for `owner/slug` lives under `homeDir`. */
export function agentToolsManifestPath(input: {
  homeDir: string;
  owner: string;
  slug: string;
}): string {
  return path.join(
    input.homeDir,
    ".scarn",
    "projects",
    input.owner,
    input.slug,
    AGENT_TOOLS_MANIFEST_FILENAME,
  );
}

/** The `requiredEnv` names that are unset or empty in `env`. */
export function missingRequiredEnv(
  server: Pick<DiscoveredMcpServer, "requiredEnv">,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return server.requiredEnv.filter((name) => {
    const value = env[name];
    return value === undefined || value === "";
  });
}

export function buildAgentToolsManifest(input: {
  project: string;
  generatedAt: Date;
  discovered: DiscoveredAgentTools;
  /** Per server name; a server with no entry is recorded as not listed. */
  listings: ReadonlyMap<string, ManifestServerListing>;
  connections?: ManifestManagedConnection[];
  locks?: ManifestMcpToolLock[];
}): AgentToolsManifest {
  const { discovered } = input;
  const lockFor = (name: string): ManifestMcpToolLock | undefined =>
    input.locks?.find(
      (lock) => lock.status === "locked" && lock.server === name,
    );
  return {
    version: 2,
    generatedAt: input.generatedAt.toISOString(),
    project: input.project,
    caveats: AGENT_TOOLS_MANIFEST_CAVEATS,
    servers: discovered.servers.map((server) => {
      const listing = input.listings.get(server.name) ?? {
        availability: { status: "failed", reason: "not listed" },
        tools: [],
      };
      const lock = lockFor(server.name);
      return {
        name: server.name,
        source: server.source,
        transport: server.transport,
        requiredEnv: server.requiredEnv,
        inlineSecrets: server.inlineSecrets.map(({ field, key }) => ({
          field,
          key,
        })),
        shadowed: server.shadowed.map(({ source }) => source),
        ...(server.config.disabled === true
          ? { disabledInSource: true as const }
          : {}),
        ...(listing.connection === undefined
          ? {}
          : { connection: listing.connection }),
        ...(lock === undefined ? {} : { lock }),
        availability: listing.availability,
        tools: listing.tools,
      };
    }),
    ...(input.connections === undefined
      ? {}
      : { connections: input.connections }),
    ...(input.locks === undefined ? {} : { locks: input.locks }),
    skills: discovered.skills.map(({ name, description, path: file }) => ({
      name,
      description,
      path: file,
    })),
    skipped: discovered.skipped,
    searched: discovered.searched.map(({ file, present }) => ({
      file,
      present,
    })),
  };
}
