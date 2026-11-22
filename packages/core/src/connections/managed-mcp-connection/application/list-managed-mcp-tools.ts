import {
  acquireManagedAccessToken,
  forceRefreshManagedAccessToken,
  type AcquireManagedAccessTokenDeps,
  type AcquireManagedAccessTokenInput,
} from "./acquire-managed-access-token";
import { managedConnectionProviderUnavailable } from "./managed-connection-access";
import type {
  ManagedMcpTool,
  ManagedMcpToolLister,
} from "./managed-mcp-tool-lister";

export type ListManagedMcpToolsDeps = AcquireManagedAccessTokenDeps & {
  managedMcpToolLister: ManagedMcpToolLister;
};

/**
 * Internal: the tools the connection's MCP server offers, listed at the
 * connection's own resource (a grant for another resource is refused) with its
 * current access token (refreshed first if it is about to expire). If the
 * server rejects the token, it is force-refreshed once and the listing
 * retried once; `tools/list` is read-only, so the retry is safe. Any other
 * listing failure, or a second rejection, is
 * `MANAGED_CONNECTION_PROVIDER_UNAVAILABLE`. Token errors propagate as
 * {@link acquireManagedAccessToken} throws them. Does no authorization.
 */
export const listManagedMcpTools = async (
  input: AcquireManagedAccessTokenInput,
  deps: ListManagedMcpToolsDeps,
): Promise<ManagedMcpTool[]> => {
  const token = await acquireManagedAccessToken(input, deps);
  const first = await deps.managedMcpToolLister.listTools({
    server: token.server,
    accessToken: token.accessToken,
  });
  if (first.status === "listed") {
    return first.tools;
  }
  if (first.failure !== "unauthorized") {
    throw managedConnectionProviderUnavailable();
  }

  const refreshed = await forceRefreshManagedAccessToken(
    { ...input, rejectedAccessToken: token.accessToken },
    deps,
  );
  const retry = await deps.managedMcpToolLister.listTools({
    server: refreshed.server,
    accessToken: refreshed.accessToken,
  });
  if (retry.status === "listed") {
    return retry.tools;
  }
  throw managedConnectionProviderUnavailable();
};
