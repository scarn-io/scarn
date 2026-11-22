import { Elysia } from "elysia";
import { getIdentityAuth } from "@scarn/identity";
import type { AppContext } from "@scarn/core/lib/di";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { handleManagedOAuthCallback } from "@scarn/core/connections/managed-mcp-connection/application/handle-managed-oauth-callback";
import {
  MANAGED_OAUTH_CALLBACK_PATH,
  MANAGED_OAUTH_CLIENT_METADATA_PATH,
  managedOAuthClientMetadataDocument,
  managedOAuthClientMetadataDocumentSchema,
} from "@scarn/core/connections/managed-mcp-connection/contracts/managed-oauth-client-metadata";
import { cimdClientIdentity } from "@scarn/core/connections/managed-mcp-connection/infra/cimd-client-registry";
import { apiErrorResponseSchema } from "../../contracts";
import { responseSchemas } from "../response-schemas";
import { appRedirectUrl } from "./app-redirect";
import { resolveProjectSettingsPath } from "./github-install-flow";

const getSession = async (
  request: Request,
): Promise<{ userId: string; sessionId: string } | null> => {
  const session = await getIdentityAuth().api.getSession({
    headers: request.headers,
  });
  return session
    ? { userId: session.user.id, sessionId: session.session.id }
    : null;
};

/** A redirect that leaks neither its own URL nor the callback's to the next page. */
const redirect = (
  appContext: AppContext,
  request: Request,
  path: string,
  params: Record<string, string> = {},
): Response =>
  new Response(null, {
    status: 302,
    headers: {
      location: appRedirectUrl(appContext, request, path, params).toString(),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });

/**
 * Public OAuth endpoints for managed MCP connections.
 *
 * - The Client ID Metadata Document is fetched by the provider (not a
 *   browser), so it needs no session; its URL is Scarn's `client_id`.
 * - The callback is the provider's top-level redirect back, so it checks the
 *   session inline (redirecting a signed-out browser to `/login` with no
 *   query string) and is exempt from the `Origin` check: `state` and the
 *   browser-session binding protect it. It always redirects, to the project's
 *   settings page with `?connection=<id>` or a safe `error` code. The query
 *   string is never logged.
 */
export const createManagedMcpOAuthRoutes = (appContext: AppContext) =>
  new Elysia()
    .get(
      MANAGED_OAUTH_CLIENT_METADATA_PATH,
      {
        response: responseSchemas({
          200: managedOAuthClientMetadataDocumentSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "getManagedMcpOAuthClientMetadata",
          description:
            "Scarn's OAuth Client ID Metadata Document for managed MCP connections. Its URL is Scarn's `client_id`.",
          tags: ["Connections"],
        },
      },
      ({ set }) => {
        set.headers["cache-control"] = "public, max-age=300";
        return managedOAuthClientMetadataDocument(
          cimdClientIdentity(appContext.apiBaseUrl),
        );
      },
    )
    .get(
      MANAGED_OAUTH_CALLBACK_PATH,
      {
        detail: {
          operationId: "managedMcpOAuthCallback",
          description:
            "The provider's OAuth redirect back to Scarn. Always answers with a 302.",
          tags: ["Connections"],
        },
      },
      async ({ request }) => {
        const session = await getSession(request);
        if (!session) {
          return redirect(appContext, request, "/login");
        }
        const outcome = await handleManagedOAuthCallback(
          {
            query: new URL(request.url).search.replace(/^\?/u, ""),
            session: {
              userId: parseUuidV7(session.userId),
              sessionId: session.sessionId,
            },
          },
          appContext,
        );
        if (outcome.status === "candidate_stored") {
          return redirect(
            appContext,
            request,
            await resolveProjectSettingsPath(appContext, outcome.projectId),
            { connection: outcome.connectionId },
          );
        }
        const path =
          outcome.projectId === null
            ? "/"
            : await resolveProjectSettingsPath(appContext, outcome.projectId);
        return redirect(appContext, request, path, { error: outcome.error });
      },
    );
