import { existsSync } from "node:fs";
import { join } from "node:path";
import { collectEnvPlaceholderNames } from "@scarn/sdk/opencode-mcp";
import { PIPELINE_BUILDER_DIR, type DiscoveredMcpServer } from "@scarn/worker";
import { CliError } from "./cli-error";
import {
  lockedServers,
  type Context,
  type ImportedMcpHandle,
  type LockedServer,
  type McpPullSelection,
  type PullTarget,
} from "./mcp-pull-context";

/**
 * Where `scarn mcp pull` finds a server, the way a `ref` is resolved: the
 * repository's MCP config first, then a `defineMcp` handle in the builder
 * directory. A handle with `auth` names its connection and is listed through
 * the API; a remote server at one of the project's connections' resource is
 * too (see `Context.list`).
 */

export type ResolvedTarget =
  | { ok: true; target: PullTarget }
  | { ok: false; server: string; reason: string };

export async function selectedTargets(
  context: Context,
  selection: McpPullSelection,
): Promise<ResolvedTarget[]> {
  switch (selection.kind) {
    case "server":
      return [
        { ok: true, target: await resolveServer(context, selection.server) },
      ];
    case "handle":
      return [
        { ok: true, target: await resolveHandleSelection(context, selection) },
      ];
    case "all": {
      const resolved: ResolvedTarget[] = [];
      for (const locked of lockedServers(context)) {
        resolved.push(await resolveLocked(context, locked));
      }
      return resolved;
    }
  }
}

export async function resolveLocked(
  context: Context,
  locked: LockedServer,
): Promise<ResolvedTarget> {
  if (!locked.ok) {
    return { ok: false, server: locked.file, reason: locked.reason };
  }
  try {
    return {
      ok: true,
      target: await resolveServer(context, locked.lock.server),
    };
  } catch (error) {
    return {
      ok: false,
      server: locked.lock.server,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The repository's MCP config first, then a builder handle with that name.
 * Throws with every known name when neither has it.
 */
async function resolveServer(
  context: Context,
  name: string,
): Promise<PullTarget> {
  const repoServers = await context.repoServers();
  const repoServer = repoServers.find((server) => server.name === name);
  if (repoServer !== undefined) return repoTarget(name, repoServer);

  const imported = await context.handles();
  const handle = imported.handles.find((candidate) => candidate.name === name);
  if (handle !== undefined) return handleTarget(context, handle);

  const known = [
    ...new Set([
      ...repoServers.map((server) => server.name),
      ...imported.handles.map((candidate) => candidate.name),
    ]),
  ].sort();
  const brokenFiles =
    imported.errors.length === 0
      ? ""
      : ` (${String(imported.errors.length)} builder file(s) failed to import: ${imported.errors.map((error) => error.file).join(", ")})`;
  throw new CliError(
    "mcp_server_not_found",
    `No MCP server named "${name}" in this repository's MCP config or the defineMcp handles in ${PIPELINE_BUILDER_DIR}${brokenFiles}. ` +
      (known.length === 0
        ? "No MCP servers were found."
        : `Known servers: ${known.join(", ")}.`),
  );
}

function repoTarget(name: string, server: DiscoveredMcpServer): PullTarget {
  return { name, kind: "listed", server };
}

async function resolveHandleSelection(
  context: Context,
  selection: { file: string; exportName: string | undefined },
): Promise<PullTarget> {
  const label =
    selection.exportName === undefined
      ? selection.file
      : `${selection.file}#${selection.exportName}`;
  if (!existsSync(join(context.builderDir, selection.file))) {
    throw new CliError(
      "mcp_server_not_found",
      `No file ${selection.file} in ${PIPELINE_BUILDER_DIR}.`,
    );
  }
  const imported = await context.ports.importHandles({
    file: selection.file,
    exportName: selection.exportName,
  });
  const [handle, ...others] = imported.handles;
  if (handle === undefined) {
    throw new CliError(
      "mcp_server_not_found",
      `${label} does not export a defineMcp handle.`,
    );
  }
  if (others.length > 0) {
    throw new CliError(
      "invalid_usage",
      `${selection.file} exports several defineMcp handles; pick one with --handle ${selection.file}#<export> (${imported.handles.map((candidate) => candidate.exportName).join(", ")}).`,
    );
  }
  return handleTarget(context, handle);
}

async function handleTarget(
  context: Context,
  handle: ImportedMcpHandle,
): Promise<PullTarget> {
  const { connection, name } = handle;
  if (connection.type !== "local" && connection.auth !== undefined) {
    return { name, kind: "managed", connection: connection.auth.connection };
  }
  if (connection.type === "ref") {
    const repoServer = (await context.repoServers()).find(
      (server) => server.name === name,
    );
    if (repoServer === undefined) {
      throw new CliError(
        "mcp_server_not_found",
        `${handle.file}#${handle.exportName} is a ref to "${name}", which this repository's MCP config doesn't define.`,
      );
    }
    return repoTarget(name, repoServer);
  }
  const config =
    connection.type === "local"
      ? {
          type: "local" as const,
          command: connection.command,
          ...(connection.cwd === undefined ? {} : { cwd: connection.cwd }),
          ...(connection.environment === undefined
            ? {}
            : { environment: connection.environment }),
        }
      : {
          type: "remote" as const,
          url: connection.url,
          ...(connection.headers === undefined
            ? {}
            : { headers: connection.headers }),
        };
  return repoTarget(name, {
    name,
    source: `${PIPELINE_BUILDER_DIR}/${handle.file}`,
    transport: config.type,
    config,
    requiredEnv: collectEnvPlaceholderNames(config).sort(),
    inlineSecrets: [],
    shadowed: [],
  });
}
