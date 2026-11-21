import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ManagedConnectionName } from "@scarn/sdk/managed-connections";
import {
  parseMcpToolLock,
  type McpToolLock,
} from "@scarn/sdk/mcp-tools/codegen";
import {
  listMcpServerTools,
  type DiscoveredMcpServer,
  type ListedMcpTool,
  type McpServerAvailability,
  type McpToolLister,
} from "@scarn/worker";
import {
  resolveManagedConnections,
  type ManagedConnectionsPorts,
  type ResolvedManagedConnections,
} from "./design-managed-connections";
import type { BaseReporter } from "./reporter-types";

/**
 * The types and shared state of `scarn mcp pull` (see `mcp-pull.ts`): its
 * ports, the per-run context that lists a server through the designer's
 * lister or the API, and the locks already in the builder's `mcp/`.
 */

export const MCP_TOOLS_DIR = "mcp";

/** A handle's connection fields as written, with `{env:VAR}` placeholders. */
export type McpHandleConnection =
  | {
      type: "local";
      command: string[];
      cwd?: string;
      environment?: Record<string, string>;
    }
  | {
      type: "remote";
      url: string;
      headers?: Record<string, string>;
      auth?: { connection: ManagedConnectionName };
    }
  | { type: "ref"; auth?: { connection: ManagedConnectionName } };

/** A `defineMcp` handle exported by a builder file. */
export type ImportedMcpHandle = {
  /** Builder-directory-relative file. */
  file: string;
  exportName: string;
  /** The handle's `name`: the server's name for a `ref`, a label otherwise. */
  name: string;
  connection: McpHandleConnection;
  /** `source.server` of the catalog bound with `withTools`, if any. */
  catalogServer: string | null;
};

export type ImportedMcpHandles = {
  handles: ImportedMcpHandle[];
  /** Builder files that failed to import. */
  errors: { file: string; message: string }[];
};

export interface McpPullPorts extends ManagedConnectionsPorts {
  /** The repository's MCP servers (`discoverRepoAgentTools(...).servers`). */
  discoverServers(): Promise<DiscoveredMcpServer[]>;
  /** `process.env` merged with `.scarn/.env`, which wins. */
  readToolEnv(): Promise<Record<string, string>>;
  mcpToolLister: McpToolLister;
  /**
   * Imports the builder directory's handles: one file (optionally one
   * export) when `request` is set, every top-level file otherwise.
   */
  importHandles(request?: {
    file: string;
    exportName?: string | undefined;
  }): Promise<ImportedMcpHandles>;
  /** The signed-in project, needed only for a managed connection. */
  resolveProject(): Promise<{ baseUrl: string; projectId: string }>;
}

export type McpPullSelection =
  | { kind: "server"; server: string }
  | { kind: "handle"; file: string; exportName: string | undefined }
  | { kind: "all" };

export type McpPullResult = {
  /** Servers whose lock was written or confirmed. */
  pulled: string[];
  /** With `check`: locked servers whose live tools differ from the lock. */
  drifted: string[];
  /** Servers that could not be resolved or listed, with the reason. */
  failed: { server: string; reason: string }[];
};

export type PullTarget =
  | { name: string; kind: "listed"; server: DiscoveredMcpServer }
  | { name: string; kind: "managed"; connection: ManagedConnectionName };

export type Listing =
  { ok: true; tools: ListedMcpTool[] } | { ok: false; reason: string };

export type Context = {
  builderDir: string;
  mcpDir: string;
  reporter: BaseReporter;
  ports: McpPullPorts;
  now: () => Date;
  timeoutMs: number | undefined;
  handles(): Promise<ImportedMcpHandles>;
  repoServers(): Promise<DiscoveredMcpServer[]>;
  list(target: PullTarget): Promise<Listing>;
};

export function createContext(input: {
  builderDir: string;
  reporter: BaseReporter;
  ports: McpPullPorts;
  now?: () => Date;
  timeoutMs?: number;
}): Context {
  const { ports } = input;
  let handles: Promise<ImportedMcpHandles> | undefined;
  let repoServers: Promise<DiscoveredMcpServer[]> | undefined;
  let env: Promise<Record<string, string>> | undefined;
  let managed: Promise<ResolvedManagedConnections> | undefined;
  const managedConnections = () =>
    (managed ??= ports
      .resolveProject()
      .then((project) => resolveManagedConnections({ ...project, ports })));
  const context: Context = {
    builderDir: input.builderDir,
    mcpDir: join(input.builderDir, MCP_TOOLS_DIR),
    reporter: input.reporter,
    ports,
    now: input.now ?? (() => new Date()),
    timeoutMs: input.timeoutMs,
    handles: () => {
      handles ??= existsSync(input.builderDir)
        ? ports.importHandles()
        : Promise.resolve({ handles: [], errors: [] });
      return handles;
    },
    repoServers: () => (repoServers ??= ports.discoverServers()),
    list: async (target) => {
      if (target.kind === "managed") {
        const connections = await managedConnections();
        return toListing(connections.connectionByName(target.connection));
      }
      if (target.server.config.type === "remote") {
        const connections = await managedConnections().catch(() => null);
        const listing = connections?.connectionForServer(target.server);
        if (listing) return toListing(listing);
      }
      env ??= ports.readToolEnv();
      const listings = await listMcpServerTools({
        servers: [target.server],
        env: await env,
        lister: ports.mcpToolLister,
        ...(context.timeoutMs === undefined
          ? {}
          : { timeoutMs: context.timeoutMs }),
      });
      const listing = listings.get(target.server.name);
      return listing === undefined
        ? { ok: false, reason: "the server was not listed" }
        : toListing(listing);
    },
  };
  return context;
}

function toListing(listing: {
  availability: McpServerAvailability;
  tools: ListedMcpTool[];
}): Listing {
  return listing.availability.status === "available"
    ? { ok: true, tools: listing.tools }
    : {
        ok: false,
        reason: `${listing.availability.status}: ${listing.availability.reason}`,
      };
}

export type LockedServer =
  | { ok: true; file: string; lock: McpToolLock }
  | { ok: false; file: string; reason: string };

export function lockedServers(context: Context): LockedServer[] {
  return readMcpToolLocks(context.mcpDir);
}

/** Every `*.lock.json` in `mcpDir`, by file name, parsed and hash-checked. */
export function readMcpToolLocks(mcpDir: string): LockedServer[] {
  if (!existsSync(mcpDir)) return [];
  return readdirSync(mcpDir)
    .filter((file) => file.endsWith(".lock.json"))
    .sort()
    .map((file): LockedServer => {
      try {
        return {
          ok: true,
          file,
          lock: parseMcpToolLock(readFileSync(join(mcpDir, file), "utf8")),
        };
      } catch (error) {
        return {
          ok: false,
          file,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    });
}
