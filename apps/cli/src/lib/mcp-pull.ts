import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildMcpToolLock,
  generateMcpToolCatalogSource,
  mcpToolCatalogFileName,
  mcpToolLockFileName,
  mcpToolLockHash,
  parseMcpToolLock,
  serializeMcpToolLock,
  type McpToolLock,
} from "@scarn/sdk/mcp-tools/codegen";
import { PIPELINE_BUILDER_DIR, type ListedMcpTool } from "@scarn/worker";
import { CliError } from "./cli-error";
import {
  createContext,
  lockedServers,
  MCP_TOOLS_DIR,
  type Context,
  type ImportedMcpHandles,
  type McpPullPorts,
  type McpPullResult,
  type McpPullSelection,
} from "./mcp-pull-context";
import { resolveLocked, selectedTargets } from "./mcp-pull-targets";
import type { BaseReporter } from "./reporter-types";

/**
 * `scarn mcp pull` (ADR 0014): list an MCP server's tools and write its
 * `<server>.lock.json` and generated `<server>.tools.ts` catalog into
 * `.scarn/pipeline-builder/mcp/`.
 *
 * A server is found the way a `ref` is: in the repository's MCP config first,
 * then among the `defineMcp` handles in the builder directory. Local and
 * remote servers are listed on this machine through the designer's lister;
 * a server backed by a managed connection is listed by the API, never by
 * connecting to the provider. Connection config is only read: `{env:VAR}`
 * values are substituted in memory by the lister, and nothing but tool
 * metadata is written or printed.
 *
 * `check` re-lists every locked server and fails on a hash change, without
 * writing anything. It also warns when a handle is bound to a catalog pulled
 * from a differently named server, which is allowed (an alias) but worth a
 * second look.
 */

export {
  MCP_TOOLS_DIR,
  type ImportedMcpHandle,
  type ImportedMcpHandles,
  type McpHandleConnection,
  type McpPullPorts,
  type McpPullResult,
  type McpPullSelection,
} from "./mcp-pull-context";

/** `mcps.ts#notion` → `{ file: "mcps.ts", exportName: "notion" }`. */
export function parseHandleSpecifier(specifier: string): {
  file: string;
  exportName: string | undefined;
} {
  const hash = specifier.lastIndexOf("#");
  const file = hash === -1 ? specifier : specifier.slice(0, hash);
  const exportName = hash === -1 ? undefined : specifier.slice(hash + 1);
  if (file.trim() === "" || exportName === "") {
    throw new CliError(
      "invalid_usage",
      `--handle expects <file>#<export> (e.g. mcps.ts#notion), got "${specifier}".`,
    );
  }
  return { file, exportName };
}

export async function runMcpPull(input: {
  builderDir: string;
  selection: McpPullSelection | undefined;
  check: boolean;
  reporter: BaseReporter;
  ports: McpPullPorts;
  now?: () => Date;
  timeoutMs?: number;
}): Promise<McpPullResult> {
  const context = createContext(input);
  if (input.check) return runCheck(context, input.selection);
  if (input.selection === undefined) {
    throw new CliError(
      "invalid_usage",
      "Name a server (`scarn mcp pull <server>`), or pass --handle, --all or --check.",
    );
  }

  const result: McpPullResult = { pulled: [], drifted: [], failed: [] };
  const targets = await selectedTargets(context, input.selection);
  if (targets.length === 0) {
    input.reporter.info(
      `No MCP tool locks in ${PIPELINE_BUILDER_DIR}/${MCP_TOOLS_DIR} yet. Pull a server first with \`scarn mcp pull <server>\`.`,
    );
    return result;
  }
  for (const resolved of targets) {
    if (!resolved.ok) {
      result.failed.push({ server: resolved.server, reason: resolved.reason });
      continue;
    }
    const listing = await context.list(resolved.target);
    if (!listing.ok) {
      result.failed.push({
        server: resolved.target.name,
        reason: listing.reason,
      });
      continue;
    }
    writeLock(context, resolved.target.name, listing.tools);
    result.pulled.push(resolved.target.name);
  }
  failOn(result, "mcp_pull_failed", "Could not pull");
  return result;
}

function readExistingLock(
  context: Context,
  server: string,
): McpToolLock | null {
  const path = join(context.mcpDir, mcpToolLockFileName(server));
  if (!existsSync(path)) return null;
  try {
    return parseMcpToolLock(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Writes the lock and the generated catalog. An unchanged server keeps its
 * lock (and `listedAt`), so a re-pull doesn't churn the file.
 */
function writeLock(
  context: Context,
  server: string,
  listed: readonly ListedMcpTool[],
): void {
  const existing = readExistingLock(context, server);
  const lock =
    existing?.hash === mcpToolLockHash(server, listed)
      ? existing
      : buildMcpToolLock({ server, listedAt: context.now(), tools: listed });
  const unchanged = lock === existing;
  const generated = generateMcpToolCatalogSource(lock);

  mkdirSync(context.mcpDir, { recursive: true });
  writeFileSync(
    join(context.mcpDir, mcpToolLockFileName(server)),
    serializeMcpToolLock(lock),
    "utf8",
  );
  writeFileSync(
    join(context.mcpDir, mcpToolCatalogFileName(server)),
    generated.source,
    "utf8",
  );

  for (const warning of generated.warnings) {
    context.reporter.warn(`${server}: ${warning}`);
  }
  const where = `${PIPELINE_BUILDER_DIR}/${MCP_TOOLS_DIR}/${mcpToolCatalogFileName(server)}`;
  context.reporter.success(
    unchanged
      ? `${server}: ${String(lock.tools.length)} tool(s), unchanged (${where})`
      : `${server}: wrote ${String(lock.tools.length)} tool(s) to ${where} as ${generated.exportName}`,
  );
}

async function runCheck(
  context: Context,
  selection: McpPullSelection | undefined,
): Promise<McpPullResult> {
  if (selection?.kind === "handle") {
    throw new CliError(
      "invalid_usage",
      "--check reads the locks; pass a server name or nothing, not --handle.",
    );
  }
  const result: McpPullResult = { pulled: [], drifted: [], failed: [] };
  const selected = lockedServers(context).filter(
    (locked) =>
      selection?.kind !== "server" ||
      (locked.ok && locked.lock.server === selection.server),
  );
  if (selection?.kind === "server" && selected.length === 0) {
    throw new CliError(
      "mcp_server_not_found",
      `No lock for "${selection.server}" in ${PIPELINE_BUILDER_DIR}/${MCP_TOOLS_DIR}. Pull it first with \`scarn mcp pull ${selection.server}\`.`,
    );
  }

  for (const locked of selected) {
    const resolved = await resolveLocked(context, locked);
    if (!locked.ok || !resolved.ok) {
      result.failed.push(
        resolved.ok
          ? { server: locked.file, reason: "unreadable lock" }
          : { server: resolved.server, reason: resolved.reason },
      );
      continue;
    }
    const { target } = resolved;
    const listing = await context.list(target);
    if (!listing.ok) {
      result.failed.push({ server: target.name, reason: listing.reason });
      continue;
    }
    const { lock } = locked;
    const live = mcpToolLockHash(target.name, listing.tools);
    if (live === lock.hash) {
      result.pulled.push(target.name);
      context.reporter.success(`${target.name}: matches its lock`);
    } else {
      result.drifted.push(target.name);
      context.reporter.error(
        `${target.name}: its tools changed since the lock (${describeDrift(lock, listing.tools)}). Run \`scarn mcp pull ${target.name}\`.`,
      );
    }
  }

  await warnAboutAliases(context);

  if (selected.length === 0) {
    context.reporter.info(
      `No MCP tool locks in ${PIPELINE_BUILDER_DIR}/${MCP_TOOLS_DIR}; nothing to check.`,
    );
  }
  if (result.drifted.length > 0) {
    failOn(result, "mcp_tools_drift", "MCP tools drifted from their locks");
  }
  failOn(result, "mcp_pull_failed", "Could not check");
  return result;
}

function describeDrift(
  lock: McpToolLock,
  live: readonly ListedMcpTool[],
): string {
  const locked = new Map(lock.tools.map((tool) => [tool.name, tool]));
  const liveNames = new Set(live.map((tool) => tool.name));
  const added = live
    .filter((tool) => !locked.has(tool.name))
    .map((tool) => tool.name);
  const removed = lock.tools
    .filter((tool) => !liveNames.has(tool.name))
    .map((tool) => tool.name);
  const changed = live
    .filter((tool) => {
      const before = locked.get(tool.name);
      return (
        before !== undefined &&
        mcpToolLockHash(lock.server, [before]) !==
          mcpToolLockHash(lock.server, [tool])
      );
    })
    .map((tool) => tool.name);
  const parts = [
    added.length > 0 ? `added ${added.join(", ")}` : null,
    removed.length > 0 ? `removed ${removed.join(", ")}` : null,
    changed.length > 0 ? `changed ${changed.join(", ")}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join("; ") : "content changed";
}

async function warnAboutAliases(context: Context): Promise<void> {
  let imported: ImportedMcpHandles;
  try {
    imported = await context.handles();
  } catch (error) {
    context.reporter.warn(
      `Could not read the defineMcp handles in ${PIPELINE_BUILDER_DIR} to check their catalogs: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  for (const handle of imported.handles) {
    if (handle.catalogServer === null || handle.catalogServer === handle.name) {
      continue;
    }
    context.reporter.warn(
      `${handle.file}#${handle.exportName}: the handle "${handle.name}" uses the catalog pulled from "${handle.catalogServer}". That's fine for an alias; make sure both are the same server.`,
    );
  }
}

function failOn(
  result: McpPullResult,
  code: "mcp_pull_failed" | "mcp_tools_drift",
  heading: string,
): void {
  if (code === "mcp_tools_drift") {
    const failed =
      result.failed.length === 0
        ? ""
        : `; could not list ${result.failed.map((entry) => `${entry.server} (${entry.reason})`).join(", ")}`;
    throw new CliError(
      code,
      `${heading}: ${result.drifted.join(", ")}${failed}.`,
    );
  }
  if (result.failed.length === 0) return;
  throw new CliError(
    code,
    `${heading} ${result.failed.map((entry) => `${entry.server}: ${entry.reason}`).join("; ")}`,
  );
}
