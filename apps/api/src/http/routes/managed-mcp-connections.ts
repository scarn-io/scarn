import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { cancelManagedCandidate } from "@scarn/core/connections/managed-mcp-connection/application/cancel-managed-candidate";
import { confirmManagedCandidate } from "@scarn/core/connections/managed-mcp-connection/application/confirm-managed-candidate";
import { disconnectManagedConnection } from "@scarn/core/connections/managed-mcp-connection/application/disconnect-managed-connection";
import { getManagedConnection } from "@scarn/core/connections/managed-mcp-connection/application/get-managed-connection";
import { listManagedConnectionTools } from "@scarn/core/connections/managed-mcp-connection/application/list-managed-connection-tools";
import { listManagedConnectionPresets } from "@scarn/core/connections/managed-mcp-connection/application/list-managed-connection-presets";
import { listManagedConnections } from "@scarn/core/connections/managed-mcp-connection/application/list-managed-connections";
import { loadManagedConnectionUsage } from "@scarn/core/connections/managed-mcp-connection/application/load-managed-connection-usage";
import { startManagedConnectionFromPreset } from "@scarn/core/connections/managed-mcp-connection/application/start-managed-connection-from-preset";
import { startManagedReconnect } from "@scarn/core/connections/managed-mcp-connection/application/start-managed-reconnect";
import {
  cancelManagedCandidateSchema,
  confirmManagedCandidateSchema,
  disconnectManagedConnectionResponseSchema,
  managedConnectionPresetSchema,
  managedConnectionSchema,
  managedConnectionToolsSchema,
  managedConnectionUsageSchema,
  startManagedConnectionFromPresetSchema,
  startManagedConnectionResponseSchema,
} from "@scarn/core/connections/managed-mcp-connection/contracts/managed-connection-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import {
  createAuthenticated,
  createOptionallyAuthenticated,
  createSessionAuthenticated,
} from "./authenticated";
import { stdErrors } from "./task-run-route-helpers";
import { requireTrustedOrigin } from "./trusted-origin";
import { responseSchemas } from "../response-schemas";

const projectParamsSchema = z.object({
  projectId: uuidV7Schema,
});

const connectionParamsSchema = z.object({
  projectId: uuidV7Schema,
  connectionId: uuidV7Schema,
});

export const mapperDepsOf = (appContext: AppContext) => ({
  managedConnectionEventRepo: appContext.managedConnectionEventRepo,
  managedOAuthGrantRepo: appContext.managedOAuthGrantRepo,
  managedGrantCrypto: appContext.managedGrantCrypto,
  usernameReader: appContext.usernameReader,
});

/**
 * Reads resolve a missing session to the anonymous actor so that it, like a
 * signed-in non-member, gets the same 404 as a missing project: membership is
 * required and there is no public-project fallback.
 */
const createManagedMcpConnectionReadRoutes = (appContext: AppContext) => {
  const mapperDeps = mapperDepsOf(appContext);
  return new Elysia()
    .use(
      createOptionallyAuthenticated(appContext.createUserAuthorizationService),
    )
    .get(
      "/projects/:projectId/mcp-connections",
      {
        params: projectParamsSchema,
        response: responseSchemas({
          200: z.array(managedConnectionSchema),
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "listManagedMcpConnections",
          tags: ["Connections"],
        },
      },
      async ({ params, auth }) =>
        await listManagedConnections(projectParamsSchema.parse(params), {
          ...mapperDeps,
          userAuthz: auth.userAuthz,
          managedConnectionRepo: appContext.managedConnectionRepo,
          timeProvider: appContext.timeProvider,
        }),
    )
    .get(
      "/projects/:projectId/mcp-connection-presets",
      {
        params: projectParamsSchema,
        response: responseSchemas({
          200: z.array(managedConnectionPresetSchema),
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "listManagedMcpConnectionPresets",
          description:
            "The services a connection can be created from. `resource` is the normalized MCP URL a connection created from the preset points at; `removalUrl` is where people remove Scarn's access on the service's side, or null.",
          tags: ["Connections"],
        },
      },
      async ({ params, auth }) =>
        await listManagedConnectionPresets(projectParamsSchema.parse(params), {
          userAuthz: auth.userAuthz,
          managedConnectionPresets: appContext.managedConnectionPresets,
        }),
    )
    .get(
      "/projects/:projectId/mcp-connections/:connectionId",
      {
        params: connectionParamsSchema,
        response: responseSchemas({
          200: managedConnectionSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "getManagedMcpConnection",
          tags: ["Connections"],
        },
      },
      async ({ params, auth }) =>
        await getManagedConnection(connectionParamsSchema.parse(params), {
          ...mapperDeps,
          userAuthz: auth.userAuthz,
          managedConnectionRepo: appContext.managedConnectionRepo,
          timeProvider: appContext.timeProvider,
        }),
    )
    .get(
      "/projects/:projectId/mcp-connections/:connectionId/usage",
      {
        params: connectionParamsSchema,
        response: responseSchemas({
          200: managedConnectionUsageSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "getManagedMcpConnectionUsage",
          tags: ["Connections"],
        },
      },
      async ({ params, auth }) =>
        await loadManagedConnectionUsage(connectionParamsSchema.parse(params), {
          userAuthz: auth.userAuthz,
          managedConnectionRepo: appContext.managedConnectionRepo,
          stepDefinitionRepo: appContext.stepDefinitionRepo,
          pipelineGraphRepo: appContext.pipelineGraphRepo,
          managedLaunchRepo: appContext.managedLaunchRepo,
        }),
    )
    .get(
      "/projects/:projectId/mcp-connections/:connectionId/tools",
      {
        params: connectionParamsSchema,
        response: responseSchemas({
          200: managedConnectionToolsSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          502: apiErrorResponseSchema,
          503: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "listManagedMcpConnectionTools",
          description:
            "Lists the tools the connection's MCP server offers. Needs `executions:write`. Listings are cached for up to 5 minutes per connection generation (`cached: true`). 409 `MANAGED_CONNECTION_NOT_READY` carries `meta.state` and `meta.reasonCode`; 503 `MANAGED_CONNECTION_REFRESH_BUSY` carries `Retry-After`.",
          tags: ["Connections"],
        },
      },
      async ({ params, auth, set }) => {
        const response = await listManagedConnectionTools(
          connectionParamsSchema.parse(params),
          {
            userAuthz: auth.userAuthz,
            managedConnectionRepo: appContext.managedConnectionRepo,
            managedOAuthGrantRepo: appContext.managedOAuthGrantRepo,
            managedConnectionEventRepo: appContext.managedConnectionEventRepo,
            managedGrantCrypto: appContext.managedGrantCrypto,
            managedOAuthProviders: appContext.managedOAuthProviders,
            managedOAuthClientRegistry: appContext.managedOAuthClientRegistry,
            managedMcpToolLister: appContext.managedMcpToolLister,
            managedMcpToolCache: appContext.managedMcpToolCache,
            timeProvider: appContext.timeProvider,
          },
        );
        set.headers["cache-control"] = "no-store";
        return response;
      },
    );
};

export const startDepsOf = (appContext: AppContext) => ({
  managedConnectionRepo: appContext.managedConnectionRepo,
  managedOAuthAttemptRepo: appContext.managedOAuthAttemptRepo,
  managedOAuthGrantRepo: appContext.managedOAuthGrantRepo,
  managedConnectionEventRepo: appContext.managedConnectionEventRepo,
  managedGrantCrypto: appContext.managedGrantCrypto,
  managedOAuthProviders: appContext.managedOAuthProviders,
  managedOAuthClientRegistry: appContext.managedOAuthClientRegistry,
  timeProvider: appContext.timeProvider,
});

/**
 * Starting a connect or reconnect binds the OAuth attempt to the caller's
 * browser session, so these need a live session rather than an access JWT.
 */
const createManagedMcpConnectionStartRoutes = (appContext: AppContext) => {
  const startDeps = startDepsOf(appContext);
  return new Elysia()
    .use(createSessionAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/projects/:projectId/mcp-connections",
      {
        params: projectParamsSchema,
        body: startManagedConnectionFromPresetSchema,
        beforeHandle: requireTrustedOrigin,
        response: responseSchemas({
          201: startManagedConnectionResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          502: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "startManagedMcpConnection",
          description:
            "Starts connecting the project to a preset's MCP server, as connection `name` (the preset key when omitted). Starting again on a disconnected or still-connecting connection of the same name and preset reuses it. An unknown preset is 422 `MANAGED_CONNECTION_PRESET_UNKNOWN`; a name taken by a connection from another preset, or an MCP URL already used by another connection, is 409 `MANAGED_CONNECTION_EXISTS`. A server that uses dynamic client registration is registered with on its first connect: a registration Scarn can't use (a client secret, another auth method or other redirect URIs) is 502 `MANAGED_CONNECTION_CLIENT_CONFIGURATION`, and a failed registration request is 502 `MANAGED_CONNECTION_PROVIDER_UNAVAILABLE`. Open `authorizationUrl` in the same browser session to authorize.",
          tags: ["Connections"],
        },
      },
      async ({ params, body, auth, set }) => {
        const response = await startManagedConnectionFromPreset(
          {
            ...startManagedConnectionFromPresetSchema.parse(body),
            projectId: projectParamsSchema.parse(params).projectId,
            binding: { kind: "browser", sessionId: auth.session.id },
          },
          {
            ...startDeps,
            managedConnectionPresets: appContext.managedConnectionPresets,
            userAuthz: auth.userAuthz,
          },
        );
        set.status = 201;
        set.headers["cache-control"] = "no-store";
        return response;
      },
    )
    .post(
      "/projects/:projectId/mcp-connections/:connectionId/reconnect",
      {
        params: connectionParamsSchema,
        beforeHandle: requireTrustedOrigin,
        response: responseSchemas({
          201: startManagedConnectionResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          502: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "reconnectManagedMcpConnection",
          description:
            "Starts reconnecting the connection. The current grant keeps serving until the new one is confirmed. Registering a new client with a server that uses dynamic client registration can fail with 502, as when starting a connection. Open `authorizationUrl` in the same browser session to authorize.",
          tags: ["Connections"],
        },
      },
      async ({ params, auth, set }) => {
        const response = await startManagedReconnect(
          {
            ...connectionParamsSchema.parse(params),
            binding: { kind: "browser", sessionId: auth.session.id },
          },
          { ...startDeps, userAuthz: auth.userAuthz },
        );
        set.status = 201;
        set.headers["cache-control"] = "no-store";
        return response;
      },
    );
};

const createManagedMcpConnectionWriteRoutes = (appContext: AppContext) => {
  const mapperDeps = mapperDepsOf(appContext);
  return new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/projects/:projectId/mcp-connections/:connectionId/candidate/confirm",
      {
        params: connectionParamsSchema,
        body: confirmManagedCandidateSchema,
        beforeHandle: requireTrustedOrigin,
        response: responseSchemas({
          200: managedConnectionSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "confirmManagedMcpCandidate",
          tags: ["Connections"],
        },
      },
      async ({ params, body, auth }) =>
        await confirmManagedCandidate(
          {
            ...connectionParamsSchema.parse(params),
            confirmation: confirmManagedCandidateSchema.parse(body),
          },
          {
            ...mapperDeps,
            userAuthz: auth.userAuthz,
            managedConnectionRepo: appContext.managedConnectionRepo,
            managedOAuthAttemptRepo: appContext.managedOAuthAttemptRepo,
            managedConnectionEventRepo: appContext.managedConnectionEventRepo,
            timeProvider: appContext.timeProvider,
          },
        ),
    )
    .post(
      "/projects/:projectId/mcp-connections/:connectionId/candidate/cancel",
      {
        params: connectionParamsSchema,
        body: cancelManagedCandidateSchema,
        beforeHandle: requireTrustedOrigin,
        response: responseSchemas({
          200: managedConnectionSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "cancelManagedMcpCandidate",
          tags: ["Connections"],
        },
      },
      async ({ params, body, auth }) =>
        await cancelManagedCandidate(
          {
            ...connectionParamsSchema.parse(params),
            cancellation: cancelManagedCandidateSchema.parse(body),
          },
          {
            ...mapperDeps,
            userAuthz: auth.userAuthz,
            managedConnectionRepo: appContext.managedConnectionRepo,
            managedConnectionEventRepo: appContext.managedConnectionEventRepo,
            timeProvider: appContext.timeProvider,
          },
        ),
    )
    .delete(
      "/projects/:projectId/mcp-connections/:connectionId",
      {
        params: connectionParamsSchema,
        beforeHandle: requireTrustedOrigin,
        response: responseSchemas({
          200: disconnectManagedConnectionResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "disconnectManagedMcpConnection",
          description:
            "Deletes the connection's credentials and sends the provider one revocation request. `revocation` reports what the provider answered (null when nothing was connected yet); it does not prove the tokens are gone, so point people at `providerRemovalUrl` when it isn't null (it comes from the connection's preset).",
          tags: ["Connections"],
        },
      },
      async ({ params, auth }) =>
        await disconnectManagedConnection(
          connectionParamsSchema.parse(params),
          {
            ...mapperDeps,
            userAuthz: auth.userAuthz,
            managedConnectionRepo: appContext.managedConnectionRepo,
            managedOAuthAttemptRepo: appContext.managedOAuthAttemptRepo,
            managedConnectionEventRepo: appContext.managedConnectionEventRepo,
            managedOAuthProviders: appContext.managedOAuthProviders,
            managedConnectionPresets: appContext.managedConnectionPresets,
            timeProvider: appContext.timeProvider,
          },
        ),
    );
};

/**
 * A project's managed MCP connections and the presets they're created from. Reads need
 * project membership, with no public-project fallback; every write needs
 * `secrets:write` and a trusted `Origin`. No route ever returns token
 * material.
 */
export const createManagedMcpConnectionRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createManagedMcpConnectionReadRoutes(appContext))
    .use(createManagedMcpConnectionStartRoutes(appContext))
    .use(createManagedMcpConnectionWriteRoutes(appContext));
