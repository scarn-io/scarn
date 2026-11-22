import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { ManagedMcpTool } from "./managed-mcp-tool-lister";

/** How long a listing is served from memory (decision 3). */
export const MANAGED_MCP_TOOL_CACHE_TTL_MS = 5 * 60 * 1000;

export type CachedManagedMcpTools = {
  tools: ManagedMcpTool[];
  listedAt: Date;
};

type Entry = CachedManagedMcpTools & { generation: number };

/**
 * Per-process memory cache of tool listings, keyed by connection and
 * generation: a listing is served only for the generation it was listed
 * under and only until `listedAt + TTL`. Holds no token material.
 */
export class ManagedMcpToolCache {
  private readonly entries = new Map<UuidV7, Entry>();

  constructor(private readonly ttlMs: number = MANAGED_MCP_TOOL_CACHE_TTL_MS) {}

  get(
    connectionId: UuidV7,
    generation: number,
    now: Date,
  ): CachedManagedMcpTools | null {
    const entry = this.entries.get(connectionId);
    if (!entry) {
      return null;
    }
    if (
      entry.generation !== generation ||
      now.getTime() - entry.listedAt.getTime() >= this.ttlMs
    ) {
      this.entries.delete(connectionId);
      return null;
    }
    return { tools: entry.tools, listedAt: entry.listedAt };
  }

  set(
    connectionId: UuidV7,
    generation: number,
    value: CachedManagedMcpTools,
  ): void {
    this.entries.set(connectionId, { ...value, generation });
  }

  evict(connectionId: UuidV7): void {
    this.entries.delete(connectionId);
  }
}
