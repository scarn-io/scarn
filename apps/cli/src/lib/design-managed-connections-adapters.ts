import { connectApi, type AuthenticatedApi } from "./cli-api-client";
import type {
  ManagedConnectionsApiFailure,
  ManagedConnectionsPorts,
} from "./design-managed-connections";

/**
 * The real {@link ManagedConnectionsPorts}: the generated client's
 * `mcp-connections` list and tools routes. Only the status, the 409's state
 * and reason code, and the 503's `Retry-After` are read from a failure.
 */

export function createManagedConnectionsAdapters(
  connect: (baseUrl: string) => Promise<AuthenticatedApi> = connectApi,
): ManagedConnectionsPorts {
  return {
    async listManagedConnections({ baseUrl, projectId }) {
      const { client } = await connect(baseUrl);
      const { data, response } =
        await client.connections.listManagedMcpConnections({
          path: { projectId },
        });
      return data === undefined
        ? failure(response)
        : { ok: true, connections: data };
    },

    async listManagedConnectionTools({ baseUrl, projectId, connectionId }) {
      const { client } = await connect(baseUrl);
      const { data, error, response } =
        await client.connections.listManagedMcpConnectionTools({
          path: { projectId, connectionId },
        });
      if (data !== undefined) return { ok: true, tools: data.tools };
      const meta = (error as { meta?: Record<string, unknown> } | undefined)
        ?.meta;
      return {
        ...failure(response),
        state: typeof meta?.["state"] === "string" ? meta["state"] : undefined,
        reasonCode:
          typeof meta?.["reasonCode"] === "string" ||
          meta?.["reasonCode"] === null
            ? meta["reasonCode"]
            : undefined,
      };
    },
  };
}

function failure(response: Response | undefined): ManagedConnectionsApiFailure {
  const retryAfter = response?.headers.get("Retry-After");
  const seconds =
    retryAfter === null || retryAfter === undefined
      ? Number.NaN
      : Number(retryAfter);
  return {
    ok: false,
    status: response?.status ?? null,
    ...(Number.isFinite(seconds) ? { retryAfterSeconds: seconds } : {}),
  };
}
