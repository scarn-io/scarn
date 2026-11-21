import {
  mcpToolCatalogFileName,
  mcpToolLockHash,
} from "@scarn/sdk/mcp-tools/codegen";
import type { ManifestMcpToolLock, ManifestServerListing } from "@scarn/worker";
import { MCP_TOOLS_DIR, type LockedServer } from "./mcp-pull-context";

/**
 * The designer manifest's view of `scarn mcp pull`'s locks: which servers
 * already have a typed catalog in the builder's `mcp/`, and whether the tools
 * the preflight just listed still match each lock.
 */
export function manifestMcpToolLocks(
  locked: readonly LockedServer[],
  listings: ReadonlyMap<string, ManifestServerListing>,
): ManifestMcpToolLock[] {
  return locked.map((entry): ManifestMcpToolLock => {
    const file = `${MCP_TOOLS_DIR}/${entry.file}`;
    if (!entry.ok) {
      return { status: "unreadable", file, reason: entry.reason };
    }
    const { lock } = entry;
    const listing = listings.get(lock.server);
    const drift =
      listing?.availability.status !== "available"
        ? "unknown"
        : mcpToolLockHash(lock.server, listing.tools) === lock.hash
          ? "matches"
          : "drifted";
    return {
      status: "locked",
      server: lock.server,
      file,
      catalogFile: `${MCP_TOOLS_DIR}/${mcpToolCatalogFileName(lock.server)}`,
      hash: lock.hash,
      listedAt: lock.listedAt,
      toolNames: lock.tools.map((tool) => tool.name),
      drift,
    };
  });
}
