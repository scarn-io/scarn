import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { ManagedConnectionToolsContract } from "../contracts/managed-connection-contracts";
import { managedConnectionNotReady } from "./acquire-managed-access-token";
import { listManagedMcpTools } from "./list-managed-mcp-tools";
import type { ListManagedMcpToolsDeps } from "./list-managed-mcp-tools";
import {
  ManagedConnectionNotReadyError,
  managedConnectionNotFound,
  requireConnectionToolLister,
} from "./managed-connection-access";
import type {
  CachedManagedMcpTools,
  ManagedMcpToolCache,
} from "./managed-mcp-tool-cache";

type ListManagedConnectionToolsDeps = ListManagedMcpToolsDeps & {
  userAuthz: UserAuthorizationService;
  managedMcpToolCache: ManagedMcpToolCache;
};

const toContract = (
  listing: CachedManagedMcpTools,
  cached: boolean,
): ManagedConnectionToolsContract => ({
  tools: listing.tools,
  listedAt: listing.listedAt.toISOString(),
  cached,
});

/**
 * The tools a `ready` (or `ready_with_pending_reconnect`) connection's MCP
 * server offers. Needs a member holding `executions:write`. A listing is
 * served from memory for 5 minutes while the connection stays at the same
 * generation; any read that finds the connection not ready drops it.
 */
export const listManagedConnectionTools = async (
  input: { projectId: UuidV7; connectionId: UuidV7 },
  deps: ListManagedConnectionToolsDeps,
): Promise<ManagedConnectionToolsContract> => {
  await requireConnectionToolLister(deps.userAuthz, input.projectId);
  const connection = await deps.managedConnectionRepo.findById(
    input.projectId,
    input.connectionId,
  );
  if (!connection) {
    deps.managedMcpToolCache.evict(input.connectionId);
    throw managedConnectionNotFound(input.connectionId);
  }
  if (
    connection.state !== "ready" &&
    connection.state !== "ready_with_pending_reconnect"
  ) {
    deps.managedMcpToolCache.evict(input.connectionId);
    throw managedConnectionNotReady(
      connection.state,
      "reasonCode" in connection ? connection.reasonCode : null,
    );
  }

  const cached = deps.managedMcpToolCache.get(
    connection.id,
    connection.generation,
    deps.timeProvider.now(),
  );
  if (cached) {
    return toContract(cached, true);
  }

  let tools;
  try {
    tools = await listManagedMcpTools(input, deps);
  } catch (error) {
    if (error instanceof ManagedConnectionNotReadyError) {
      deps.managedMcpToolCache.evict(input.connectionId);
    }
    throw error;
  }
  const listing = { tools, listedAt: deps.timeProvider.now() };
  deps.managedMcpToolCache.set(connection.id, connection.generation, listing);
  return toContract(listing, false);
};
