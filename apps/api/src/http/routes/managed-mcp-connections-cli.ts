import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { cancelManagedCandidate } from "@scarn/core/connections/managed-mcp-connection/application/cancel-managed-candidate";
import {
  completeManagedLoopbackAttempt,
  ManagedLoopbackCompletionFailedError,
} from "@scarn/core/connections/managed-mcp-connection/application/complete-managed-loopback-attempt";
import {
  probeCustomManagedConnection,
  startCustomManagedConnection,
} from "@scarn/core/connections/managed-mcp-connection/application/create-custom-managed-connection";
import { confirmManagedCandidate } from "@scarn/core/connections/managed-mcp-connection/application/confirm-managed-candidate";
import { getManagedConnection } from "@scarn/core/connections/managed-mcp-connection/application/get-managed-connection";
import { startManagedConnectionFromPreset } from "@scarn/core/connections/managed-mcp-connection/application/start-managed-connection-from-preset";
import { startManagedReconnect } from "@scarn/core/connections/managed-mcp-connection/application/start-managed-reconnect";
import {
  cancelManagedCandidateSchema,
  completeManagedLoopbackAttemptSchema,
  confirmManagedCandidateSchema,
  managedConnectionSchema,
  startManagedLoopbackConnectionSchema,
  startManagedLoopbackReconnectSchema,
  startManagedLoopbackResponseSchema,
} from "@scarn/core/connections/managed-mcp-connection/contracts/managed-connection-contracts";
import {
  managedMcpServerProbeSchema,
  probeManagedMcpServerSchema,
} from "@scarn/core/connections/managed-mcp-connection/contracts/custom-managed-connection-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { mapperDepsOf, startDepsOf } from "./managed-mcp-connections";
import { stdErrors } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

const projectParamsSchema = z.object({
  projectId: uuidV7Schema,
});

const connectionParamsSchema = z.object({
  projectId: uuidV7Schema,
  connectionId: uuidV7Schema,
});

const attemptParamsSchema = z.object({
  attemptId: uuidV7Schema,
});

const startResponses = responseSchemas({
  201: startManagedLoopbackResponseSchema,
  404: apiErrorResponseSchema,
  409: apiErrorResponseSchema,
  502: apiErrorResponseSchema,
  ...stdErrors,
});

const LOOPBACK_START_NOTE =
  "`redirectUri` is the CLI's loopback listener, `http://127.0.0.1:<port>/callback` on any port, else 422 `MANAGED_CONNECTION_REDIRECT_INVALID`. The response's `redirectUri` is the redirect the attempt uses; when it differs from the one sent (the server matches redirects exactly), listen there instead. `completionSecret` is returned only here; send it back to `POST /mcp-connection-attempts/{attemptId}/complete` with what the listener caught.";

/**
 * Loopback sign-in for the CLI (decisions 3, 4 and 8). The CLI authenticates
 * as for every other command, so these take an access token and skip the
 * trusted-`Origin` check; the guards are the loopback-only redirect and the
 * completion secret, which binds completion to the starting user and CLI.
 * Responses carrying `authorizationUrl` or `completionSecret` are `no-store`,
 * and nothing here logs a request body.
 */
export const createManagedMcpConnectionCliRoutes = (appContext: AppContext) => {
  const mapperDeps = mapperDepsOf(appContext);
  const startDeps = startDepsOf(appContext);
  return new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/projects/:projectId/mcp-connections/probe",
      {
        params: projectParamsSchema,
        body: probeManagedMcpServerSchema,
        response: responseSchemas({
          200: managedMcpServerProbeSchema,
          404: apiErrorResponseSchema,
          502: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "probeManagedMcpServer",
          description:
            "Probes a custom MCP server from the user's MCP config without storing anything, so the CLI can show the issuer before the user confirms it. An unauthenticated `initialize` must be refused with 401, then the protected-resource and authorization-server metadata must pass Scarn's checks. `resource` must be an https URL, else 422 `MANAGED_CONNECTION_RESOURCE_INVALID`; a server that fails a check is 422 `MANAGED_CONNECTION_DISCOVERY_FAILED`; one that supports neither client ID metadata documents nor dynamic registration, with no `client`, is 422 `MANAGED_CONNECTION_CLIENT_REQUIRED`; an unreachable one is 502 `MANAGED_CONNECTION_PROVIDER_UNAVAILABLE`. `client.redirectUri` must be loopback, else 422 `MANAGED_CONNECTION_REDIRECT_INVALID`.",
          tags: ["Connections"],
        },
      },
      async ({ params, body, auth }) =>
        await probeCustomManagedConnection(
          {
            ...probeManagedMcpServerSchema.parse(body),
            projectId: projectParamsSchema.parse(params).projectId,
          },
          {
            userAuthz: auth.userAuthz,
            managedMcpServerProber: appContext.managedMcpServerProber,
          },
        ),
    )
    .post(
      "/projects/:projectId/mcp-connections/loopback",
      {
        params: projectParamsSchema,
        body: startManagedLoopbackConnectionSchema,
        response: startResponses,
        detail: {
          operationId: "startManagedMcpConnectionLoopback",
          description: `Starts connecting the project to an MCP server for the CLI to complete: a preset's, as \`startManagedMcpConnection\` does, or a custom one from \`custom\`. A custom start probes the server again, as \`probeManagedMcpServer\` does, and stores the connection only when the issuer origin found is \`confirmIssuerOrigin\`, else 409 \`MANAGED_CONNECTION_ISSUER_CHANGED\` with the one found in \`meta.issuerOrigin\`. With a supplied \`client\`, \`redirectUri\` must be \`client.redirectUri\`. ${LOOPBACK_START_NOTE}`,
          tags: ["Connections"],
        },
      },
      async ({ params, body, auth, set }) => {
        const parsed = startManagedLoopbackConnectionSchema.parse(body);
        const { projectId } = projectParamsSchema.parse(params);
        const binding = {
          kind: "loopback",
          redirectUri: parsed.redirectUri,
        } as const;
        const deps = {
          ...startDeps,
          managedConnectionPresets: appContext.managedConnectionPresets,
          managedMcpServerProber: appContext.managedMcpServerProber,
          userAuthz: auth.userAuthz,
        };
        const response =
          "custom" in parsed
            ? await startCustomManagedConnection(
                { projectId, custom: parsed.custom, binding },
                deps,
              )
            : await startManagedConnectionFromPreset(
                {
                  preset: parsed.preset,
                  ...(parsed.name === undefined ? {} : { name: parsed.name }),
                  projectId,
                  binding,
                },
                deps,
              );
        set.status = 201;
        set.headers["cache-control"] = "no-store";
        return response;
      },
    )
    .post(
      "/projects/:projectId/mcp-connections/:connectionId/reconnect/loopback",
      {
        params: connectionParamsSchema,
        body: startManagedLoopbackReconnectSchema,
        response: startResponses,
        detail: {
          operationId: "reconnectManagedMcpConnectionLoopback",
          description: `Starts reconnecting the connection, as \`reconnectManagedMcpConnection\` does, for the CLI to complete. ${LOOPBACK_START_NOTE}`,
          tags: ["Connections"],
        },
      },
      async ({ params, body, auth, set }) => {
        const response = await startManagedReconnect(
          {
            ...connectionParamsSchema.parse(params),
            binding: {
              kind: "loopback",
              redirectUri:
                startManagedLoopbackReconnectSchema.parse(body).redirectUri,
            },
          },
          { ...startDeps, userAuthz: auth.userAuthz },
        );
        set.status = 201;
        set.headers["cache-control"] = "no-store";
        return response;
      },
    )
    .post(
      "/mcp-connection-attempts/:attemptId/complete",
      {
        params: attemptParamsSchema,
        body: completeManagedLoopbackAttemptSchema,
        response: responseSchemas({
          200: managedConnectionSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "completeManagedMcpConnectionAttempt",
          description:
            "Completes a loopback attempt with the redirect the CLI's listener caught. Scarn exchanges the code itself and returns the connection awaiting confirmation; no token reaches the caller. Only the user who started the attempt, holding its `completionSecret`, can complete it. A completion that stores no candidate is 409 `MANAGED_CONNECTION_COMPLETION_FAILED` with a safe `meta.reason` (e.g. `access_denied`, `exchange_failed`, `attempt_expired`); a redirect that doesn't match the caller's attempt is always `invalid_callback`.",
          tags: ["Connections"],
        },
      },
      async ({ params, body, auth, set }) => {
        const outcome = await completeManagedLoopbackAttempt(
          {
            ...completeManagedLoopbackAttemptSchema.parse(body),
            actorUserId: auth.userId,
            attemptId: attemptParamsSchema.parse(params).attemptId,
          },
          appContext,
        );
        set.headers["cache-control"] = "no-store";
        if (outcome.status === "failed") {
          throw new ManagedLoopbackCompletionFailedError(outcome.error);
        }
        return await getManagedConnection(
          { projectId: outcome.projectId, connectionId: outcome.connectionId },
          {
            ...mapperDeps,
            userAuthz: auth.userAuthz,
            managedConnectionRepo: appContext.managedConnectionRepo,
            timeProvider: appContext.timeProvider,
          },
        );
      },
    )
    .post(
      "/projects/:projectId/mcp-connections/:connectionId/candidate/confirm/cli",
      {
        params: connectionParamsSchema,
        body: confirmManagedCandidateSchema,
        response: responseSchemas({
          200: managedConnectionSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "confirmManagedMcpCandidateCli",
          description:
            "`confirmManagedMcpCandidate` for the CLI: takes an access token and needs no trusted `Origin`.",
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
      "/projects/:projectId/mcp-connections/:connectionId/candidate/cancel/cli",
      {
        params: connectionParamsSchema,
        body: cancelManagedCandidateSchema,
        response: responseSchemas({
          200: managedConnectionSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "cancelManagedMcpCandidateCli",
          description:
            "`cancelManagedMcpCandidate` for the CLI: takes an access token and needs no trusted `Origin`.",
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
    );
};
