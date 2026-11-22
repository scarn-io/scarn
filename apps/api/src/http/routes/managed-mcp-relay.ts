import { Elysia } from "elysia";
import { relayManagedMcpCall } from "@scarn/core/connections/managed-mcp-connection/application/relay-managed-mcp-call";
import { MANAGED_RELAY_PATH } from "@scarn/core/connections/managed-mcp-connection/contracts/managed-launch-contracts";
import type { AppContext } from "@scarn/core/lib/di";

/**
 * The managed MCP relay a run's agent calls with its relay capability as the
 * bearer. No session auth: the capability is the only credential. Bodies
 * are raw MCP traffic streamed both ways, so Elysia doesn't parse them and
 * the route is left out of the OpenAPI document. `GET` is answered with 405
 * like any other method the relay doesn't serve.
 */
export const createManagedMcpRelayRoutes = (appContext: AppContext) => {
  const relay = ({
    params,
    request,
  }: {
    params: { launchConnectionId: string };
    request: Request;
  }) =>
    relayManagedMcpCall(
      { launchConnectionId: params.launchConnectionId, request },
      {
        taskRunRepo: appContext.taskRunRepo,
        managedLaunchRepo: appContext.managedLaunchRepo,
        managedConnectionRepo: appContext.managedConnectionRepo,
        managedOAuthGrantRepo: appContext.managedOAuthGrantRepo,
        managedConnectionEventRepo: appContext.managedConnectionEventRepo,
        managedGrantCrypto: appContext.managedGrantCrypto,
        managedOAuthProviders: appContext.managedOAuthProviders,
        managedOAuthClientRegistry: appContext.managedOAuthClientRegistry,
        managedMcpPassthrough: appContext.managedMcpPassthrough,
        runAfterResponse: appContext.runAfterResponse,
        timeProvider: appContext.timeProvider,
      },
    );
  return new Elysia().all(
    `${MANAGED_RELAY_PATH}/:launchConnectionId`,
    { parse: "none", detail: { hide: true } },
    relay,
  );
};
