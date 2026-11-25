import type { Grant } from "@scarn/sdk";

/**
 * Whether a code step has a `project` work-item grant, the only kind a code
 * step may hold; its `context.workItems` calls then need the step bridge
 * (ADR 0018) even when the step declares no MCP servers.
 */
export function hasProjectWorkItemGrant(
  grants: readonly Grant[] | undefined,
): boolean {
  return (grants ?? []).some((grant) => grant.scope === "project");
}
