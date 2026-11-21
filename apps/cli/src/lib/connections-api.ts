import type {
  GetApiProjectsByProjectIdMcpConnectionPresetsResponse,
  GetApiProjectsByProjectIdMcpConnectionsByConnectionIdResponse,
  PostApiProjectsByProjectIdMcpConnectionsLoopbackResponse,
  PostApiProjectsByProjectIdMcpConnectionsProbeResponse,
} from "@scarn/sdk";
import type { createScarnClient } from "@scarn/sdk/client";
import { CliError } from "./cli-error";
import { describeApiError } from "./cli-api-client";

/**
 * The managed-connection API calls `scarn connections` makes, as a port so the
 * loopback flow can be driven by fakes. {@link createConnectionsApi} is the
 * real one over the generated client: every failure becomes a {@link CliError}
 * built from the Problem Details body, and a failed completion is explained
 * from its safe `meta.reason` only. Nothing in a request (completion secret,
 * code) is ever put in an error.
 */

export type ManagedConnection =
  GetApiProjectsByProjectIdMcpConnectionsByConnectionIdResponse;

export type StartedLoopbackAttempt =
  PostApiProjectsByProjectIdMcpConnectionsLoopbackResponse;

export type ManagedConnectionPreset =
  GetApiProjectsByProjectIdMcpConnectionPresetsResponse[number];

export type ManagedMcpServerProbe =
  PostApiProjectsByProjectIdMcpConnectionsProbeResponse;

/** A public client from the user's MCP config and its one redirect. */
export type SuppliedClient = { clientId: string; redirectUri: string };

/** A custom server from the user's MCP config, as start takes it. */
export type CustomConnectionStart = {
  name: string;
  resource: string;
  client?: SuppliedClient;
  scopes?: string[];
  confirmIssuerOrigin: string;
};

export interface ConnectionsApi {
  list(projectId: string): Promise<ManagedConnection[]>;
  listPresets(projectId: string): Promise<ManagedConnectionPreset[]>;
  probe(input: {
    projectId: string;
    resource: string;
    client?: SuppliedClient;
  }): Promise<ManagedMcpServerProbe>;
  startLoopback(input: {
    projectId: string;
    preset: string;
    name?: string;
    redirectUri: string;
  }): Promise<StartedLoopbackAttempt>;
  startCustomLoopback(input: {
    projectId: string;
    custom: CustomConnectionStart;
    redirectUri: string;
  }): Promise<StartedLoopbackAttempt>;
  reconnectLoopback(input: {
    projectId: string;
    connectionId: string;
    redirectUri: string;
  }): Promise<StartedLoopbackAttempt>;
  complete(input: {
    attemptId: string;
    completionSecret: string;
    state: string;
    code?: string;
    iss?: string;
    error?: string;
  }): Promise<ManagedConnection>;
  confirm(input: {
    projectId: string;
    connectionId: string;
    candidateId: string;
    fingerprint: string;
    expectedVersion: number;
  }): Promise<ManagedConnection>;
  cancel(input: {
    projectId: string;
    connectionId: string;
    candidateId: string;
  }): Promise<ManagedConnection>;
}

type ScarnClient = ReturnType<typeof createScarnClient>;

type ApiErrorBody = {
  title?: string;
  detail?: string;
  code?: string;
  meta?: Record<string, unknown>;
};

const COMPLETION_FAILURE_MESSAGES: Record<string, string> = {
  access_denied: "Access wasn't granted, so nothing was connected.",
  provider_error:
    "The service couldn't complete the authorization. Try connecting again.",
  invalid_callback:
    "The service's response couldn't be verified, so it was discarded. Run the command again.",
  exchange_failed:
    "Scarn couldn't finish connecting to the service. Try connecting again.",
  exchange_unknown:
    "Scarn couldn't tell whether the service finished connecting, so nothing was saved. Try connecting again.",
  missing_refresh:
    "The service didn't grant long-lived access, so nothing was saved. Try connecting again.",
  missing_expiry:
    "The service didn't say when the access expires, so nothing was saved. Try connecting again.",
  missing_identity:
    "The service didn't say which account was connected, so nothing was saved. Try connecting again.",
  client_configuration:
    "The service rejected Scarn's app configuration. Ask your Scarn administrator to check the connection setup.",
  stale_generation:
    "The connection changed while you were authorizing it, so this authorization was discarded. Run the command again.",
  permission_revoked:
    "You no longer have permission to manage this project's connections, so nothing was saved.",
  attempt_expired:
    "The authorization took longer than 10 minutes and expired. Run the command again.",
};

/** What a failed completion's `meta.reason` means, in words. */
export function completionFailureMessage(reason: string | undefined): string {
  return (
    (reason === undefined ? undefined : COMPLETION_FAILURE_MESSAGES[reason]) ??
    "Scarn couldn't finish connecting to the service. Try connecting again."
  );
}

function requestFailed(
  action: string,
  // eslint-disable-next-line local/no-unknown-parameter-type -- the generated client's error body is untyped across statuses
  error: unknown,
): CliError {
  const body = (error ?? {}) as ApiErrorBody;
  return new CliError(
    "connection_request_failed",
    `Couldn't ${action}: ${describeApiError(body)}`,
  );
}

function unwrap<T>(action: string, result: { data?: T; error?: unknown }): T {
  if (result.data === undefined) throw requestFailed(action, result.error);
  return result.data;
}

export const CLIENT_REQUIRED_MESSAGE =
  "This server doesn't let Scarn register its own client. Add `oauth.clientId` and `oauth.callbackPort` (or `oauth.redirectUri`) for it to your MCP config, then run the command again.";

function unwrapCustom<T>(
  action: string,
  result: { data?: T; error?: unknown },
): T {
  const code = (result.error as ApiErrorBody | undefined)?.code;
  if (
    result.data === undefined &&
    code === "MANAGED_CONNECTION_CLIENT_REQUIRED"
  ) {
    throw new CliError("connection_client_required", CLIENT_REQUIRED_MESSAGE);
  }
  return unwrap(action, result);
}

/** The real {@link ConnectionsApi} over the generated client. */
export function createConnectionsApi(client: ScarnClient): ConnectionsApi {
  const api = client.connections;
  return {
    async list(projectId) {
      return unwrap(
        "list the project's connections",
        await api.listManagedMcpConnections({ path: { projectId } }),
      );
    },
    async listPresets(projectId) {
      return unwrap(
        "list the connection presets",
        await api.listManagedMcpConnectionPresets({ path: { projectId } }),
      );
    },
    async startLoopback({ projectId, preset, name, redirectUri }) {
      return unwrap(
        "start connecting",
        await api.startManagedMcpConnectionLoopback({
          path: { projectId },
          body: {
            preset,
            redirectUri,
            ...(name === undefined ? {} : { name }),
          },
        }),
      );
    },
    async probe({ projectId, ...body }) {
      return unwrapCustom(
        "check the server",
        await api.probeManagedMcpServer({ path: { projectId }, body }),
      );
    },
    async startCustomLoopback({ projectId, custom, redirectUri }) {
      return unwrapCustom(
        "start connecting",
        await api.startManagedMcpConnectionLoopback({
          path: { projectId },
          body: { custom, redirectUri },
        }),
      );
    },
    async reconnectLoopback({ projectId, connectionId, redirectUri }) {
      return unwrap(
        "start reconnecting",
        await api.reconnectManagedMcpConnectionLoopback({
          path: { projectId, connectionId },
          body: { redirectUri },
        }),
      );
    },
    async complete({ attemptId, ...body }) {
      const result = await api.completeManagedMcpConnectionAttempt({
        path: { attemptId },
        body,
      });
      if (result.data !== undefined) return result.data;
      const error = result.error as ApiErrorBody;
      if (error.code === "MANAGED_CONNECTION_COMPLETION_FAILED") {
        const reason = error.meta?.["reason"];
        throw new CliError(
          "connection_completion_failed",
          completionFailureMessage(
            typeof reason === "string" ? reason : undefined,
          ),
        );
      }
      throw requestFailed("finish connecting", error);
    },
    async confirm({ projectId, connectionId, ...body }) {
      return unwrap(
        "confirm the connection",
        await api.confirmManagedMcpCandidateCli({
          path: { projectId, connectionId },
          body,
        }),
      );
    },
    async cancel({ projectId, connectionId, candidateId }) {
      return unwrap(
        "cancel the connection",
        await api.cancelManagedMcpCandidateCli({
          path: { projectId, connectionId },
          body: { candidateId },
        }),
      );
    },
  };
}
