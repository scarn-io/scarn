import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreError } from "@scarn/core/lib/errors";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import {
  isServingManagedConnection,
  type ManagedConnectionEntity,
  type ManagedConnectionReasonCode,
  type ManagedConnectionState,
  type ServingManagedConnectionEntity,
} from "../domain/managed-connection-entity";
import {
  createManagedConnectionEvent,
  type ManagedConnectionEventType,
  type ManagedRefreshFailureCode,
} from "../domain/managed-connection-event";
import type { ManagedConnectionServer } from "../domain/managed-connection-server";
import type { ManagedOAuthGrantEntity } from "../domain/managed-oauth-grant-entity";
import {
  ManagedConnectionNotReadyError,
  managedConnectionGrantMismatch,
  managedConnectionGrantMissing,
  managedConnectionNotFound,
  managedConnectionProviderUnavailable,
  managedConnectionVersionConflict,
} from "./managed-connection-access";
import type { ManagedConnectionEventRepo } from "./managed-connection-event-repo";
import type { ManagedConnectionRepo } from "./managed-connection-repo";
import type {
  ManagedGrantCredentials,
  ManagedGrantCrypto,
} from "./managed-grant-crypto";
import type { ManagedOAuthClientRegistry } from "./managed-oauth-client-registry";
import type { ManagedOAuthGrantRepo } from "./managed-oauth-grant-repo";
import { managedConnectionAudience } from "../domain/managed-connection-discovery";
import type {
  ManagedOAuthProviderTarget,
  ManagedOAuthProviders,
} from "./managed-oauth-providers";
import type { ManagedOAuthRefreshResult } from "./oauth-provider";

/** An access token is refreshed first when it expires within this window (decision 8). */
export const MANAGED_REFRESH_SKEW_MS = 60_000;

export type AcquireManagedAccessTokenDeps = {
  managedConnectionRepo: ManagedConnectionRepo;
  managedOAuthGrantRepo: ManagedOAuthGrantRepo;
  managedConnectionEventRepo: ManagedConnectionEventRepo;
  managedGrantCrypto: ManagedGrantCrypto;
  managedOAuthProviders: ManagedOAuthProviders;
  managedOAuthClientRegistry: ManagedOAuthClientRegistry;
  timeProvider: TimeProvider;
};

export type AcquireManagedAccessTokenInput = {
  projectId: UuidV7;
  connectionId: UuidV7;
};

export type ForceRefreshManagedAccessTokenInput =
  AcquireManagedAccessTokenInput & {
    /** The access token the MCP server just rejected. */
    rejectedAccessToken: string;
  };

/**
 * A usable access token for the grant the connection serves, with the
 * connection's server it is for. Never carries the refresh token.
 */
export type ManagedAccessToken = {
  accessToken: string;
  generation: number;
  grantId: UuidV7;
  server: ManagedConnectionServer;
};

export const managedConnectionNotReady = (
  state: ManagedConnectionState,
  reasonCode: ManagedConnectionReasonCode | null,
) => new ManagedConnectionNotReadyError(state, reasonCode);

export const managedConnectionRefreshBusy = () =>
  new CoreError({
    code: "MANAGED_CONNECTION_REFRESH_BUSY",
    message: "A refresh of this managed connection is already in progress",
    status: 503,
    meta: { retryAfterSeconds: 1 },
  });

export const managedConnectionChanged = () =>
  new CoreError({
    code: "MANAGED_CONNECTION_CHANGED",
    message: "The managed connection changed during the refresh",
    status: 409,
  });

type Claimed = {
  generation: number;
  /** The connection's server, which the refresh goes to. */
  target: ManagedOAuthProviderTarget;
  grant: ManagedOAuthGrantEntity;
  claimId: UuidV7;
  credentials: ManagedGrantCredentials;
};

/** What a transaction decided. `failed` is thrown only after its writes commit. */
type Step<T> =
  { kind: "done"; value: T } | { kind: "failed"; error: CoreError };

type Mode =
  { kind: "acquire" } | { kind: "force"; rejectedAccessToken: string };

const reasonCodeOf = (
  connection: ManagedConnectionEntity,
): ManagedConnectionReasonCode | null =>
  "reasonCode" in connection ? connection.reasonCode : null;

const unwrap = <T>(step: Step<T>): T => {
  if (step.kind === "failed") {
    throw step.error;
  }
  return step.value;
};

const credentialsTarget = (
  grant: ManagedOAuthGrantEntity,
  credentialVersion: number,
) => ({
  projectId: grant.projectId,
  connectionId: grant.connectionId,
  grantId: grant.id,
  credentialVersion,
});

/**
 * Inside the caller's transaction: moves the locked connection to
 * `reconnect_required`, records `events` plus a `reconnect_required` event,
 * and returns the error the caller throws after commit.
 */
const requireReconnect = async (
  connection: ServingManagedConnectionEntity,
  reasonCode: ManagedConnectionReasonCode,
  events: readonly {
    type: ManagedConnectionEventType;
    reasonCode?: ManagedRefreshFailureCode;
  }[],
  now: Date,
  deps: AcquireManagedAccessTokenDeps,
  tx: DbExecutor,
): Promise<{ kind: "failed"; error: CoreError }> => {
  const next = connection.requireReconnect(reasonCode, now);
  if (
    !(await deps.managedConnectionRepo.saveIfVersion(
      next,
      connection.version,
      tx,
    ))
  ) {
    throw managedConnectionVersionConflict();
  }
  for (const event of [
    ...events,
    { type: "reconnect_required" as const, reasonCode },
  ]) {
    await deps.managedConnectionEventRepo.append(
      createManagedConnectionEvent({
        projectId: connection.projectId,
        connectionId: connection.id,
        actorUserId: null,
        type: event.type,
        reasonCode: event.reasonCode,
        generation: next.generation,
        createdAt: now,
      }),
      tx,
    );
  }
  return {
    kind: "failed",
    error: managedConnectionNotReady(next.state, reasonCode),
  };
};

const loadServing = async (
  input: AcquireManagedAccessTokenInput,
  deps: AcquireManagedAccessTokenDeps,
  tx: DbExecutor,
): Promise<{
  connection: ManagedConnectionEntity;
  grant: ManagedOAuthGrantEntity | null;
}> => {
  const connection = await deps.managedConnectionRepo.loadForUpdate(
    input.projectId,
    input.connectionId,
    tx,
  );
  if (!connection) {
    throw managedConnectionNotFound(input.connectionId);
  }
  const grantId = connection.servingGrantId;
  const grant =
    grantId === null
      ? null
      : await deps.managedOAuthGrantRepo.findById(
          connection.projectId,
          connection.id,
          grantId,
          tx,
        );
  return { connection, grant };
};

/** Tx A: hand out the stored token, or claim the grant for one refresh. */
const claimOrServe = async (
  input: AcquireManagedAccessTokenInput,
  mode: Mode,
  deps: AcquireManagedAccessTokenDeps,
  tx: DbExecutor,
): Promise<Step<ManagedAccessToken | Claimed>> => {
  const { connection, grant } = await loadServing(input, deps, tx);
  if (!isServingManagedConnection(connection)) {
    throw managedConnectionNotReady(connection.state, reasonCodeOf(connection));
  }
  if (grant?.credentials.status !== "live") {
    throw managedConnectionGrantMissing();
  }
  if (grant.resource !== managedConnectionAudience(connection.server)) {
    throw managedConnectionGrantMismatch();
  }
  const now = deps.timeProvider.now();
  if (now.getTime() >= grant.reconnectBy.getTime()) {
    return await requireReconnect(
      connection,
      "grant_expired",
      [],
      now,
      deps,
      tx,
    );
  }
  if (grant.refreshClaim !== null) {
    if (!grant.isRefreshClaimStale(now)) {
      throw managedConnectionRefreshBusy();
    }
    await deps.managedOAuthGrantRepo.save(
      grant.releaseClaim(grant.refreshClaim.claimId, now),
      tx,
    );
    return await requireReconnect(
      connection,
      "refresh_failed",
      [{ type: "refresh_claim_recovered" }],
      now,
      deps,
      tx,
    );
  }

  const credentials = deps.managedGrantCrypto.decryptCredentials(
    credentialsTarget(grant, grant.credentialVersion),
    grant.credentials.encryptedCredentials,
  );
  const stored: ManagedAccessToken = {
    accessToken: credentials.accessToken,
    generation: connection.generation,
    grantId: grant.id,
    server: connection.server,
  };
  const stillValid =
    credentials.accessExpiresAt.getTime() - now.getTime() >
    MANAGED_REFRESH_SKEW_MS;
  if (
    mode.kind === "force"
      ? credentials.accessToken !== mode.rejectedAccessToken && stillValid
      : stillValid
  ) {
    return { kind: "done", value: stored };
  }

  const claimId = createUuidV7();
  const claimed = grant.claimRefresh(claimId, now);
  await deps.managedOAuthGrantRepo.save(claimed, tx);
  return {
    kind: "done",
    value: {
      generation: connection.generation,
      target: { server: connection.server, preset: connection.preset },
      grant: claimed,
      claimId,
      credentials,
    },
  };
};

const failureCodeOf = (
  status: Exclude<ManagedOAuthRefreshResult["status"], "refreshed">,
): ManagedRefreshFailureCode => {
  switch (status) {
    case "rejected":
      return "refresh_rejected";
    case "client_rejected":
      return "refresh_client_rejected";
    case "unknown":
      return "refresh_unknown";
    case "server_error":
      return "refresh_server_error";
    case "not_attempted":
      return "refresh_not_attempted";
  }
};

/**
 * Tx B: stores what the refresh returned, but only if the connection still
 * serves the claimed grant at the same generation and the claim is still
 * ours. Otherwise nothing is written and the result is dropped.
 */
const commitRefresh = async (
  input: AcquireManagedAccessTokenInput,
  claimed: Claimed,
  result: ManagedOAuthRefreshResult,
  deps: AcquireManagedAccessTokenDeps,
  tx: DbExecutor,
): Promise<Step<ManagedAccessToken>> => {
  const { connection, grant } = await loadServing(input, deps, tx);
  if (
    !isServingManagedConnection(connection) ||
    connection.generation !== claimed.generation ||
    connection.servingGrantId !== claimed.grant.id ||
    grant?.credentials.status !== "live" ||
    grant.refreshClaim?.claimId !== claimed.claimId ||
    grant.credentialVersion !== claimed.grant.credentialVersion
  ) {
    throw managedConnectionChanged();
  }
  const now = deps.timeProvider.now();
  const event = (
    type: ManagedConnectionEventType,
    reasonCode?: ManagedRefreshFailureCode,
  ) =>
    deps.managedConnectionEventRepo.append(
      createManagedConnectionEvent({
        projectId: connection.projectId,
        connectionId: connection.id,
        actorUserId: null,
        type,
        reasonCode,
        generation: connection.generation,
        createdAt: now,
      }),
      tx,
    );
  const saveGrant = async (next: ManagedOAuthGrantEntity) => {
    if (
      !(await deps.managedOAuthGrantRepo.saveIfClaim(
        next,
        claimed.claimId,
        grant.credentialVersion,
        tx,
      ))
    ) {
      throw managedConnectionChanged();
    }
  };

  if (result.status === "refreshed") {
    const encrypted = deps.managedGrantCrypto.encryptCredentials(
      credentialsTarget(grant, grant.credentialVersion + 1),
      result.credentials,
    );
    await saveGrant(grant.completeRefresh(claimed.claimId, encrypted, now));
    await event("refresh_succeeded");
    return {
      kind: "done",
      value: {
        accessToken: result.credentials.accessToken,
        generation: connection.generation,
        grantId: grant.id,
        server: connection.server,
      },
    };
  }

  await saveGrant(grant.releaseClaim(claimed.claimId, now));
  const failureCode = failureCodeOf(result.status);
  if (result.status === "not_attempted") {
    await event("refresh_failed", failureCode);
    return { kind: "failed", error: managedConnectionProviderUnavailable() };
  }
  return await requireReconnect(
    connection,
    "refresh_failed",
    [{ type: "refresh_failed", reasonCode: failureCode }],
    now,
    deps,
    tx,
  );
};

const acquire = async (
  input: AcquireManagedAccessTokenInput,
  mode: Mode,
  deps: AcquireManagedAccessTokenDeps,
): Promise<ManagedAccessToken> => {
  const served = unwrap(
    await getDb().transaction((tx) => claimOrServe(input, mode, deps, tx)),
  );
  if (!("claimId" in served)) {
    return served;
  }
  const result = await deps.managedOAuthProviders.for(served.target).refresh({
    grant: served.grant,
    credentials: served.credentials,
  });
  if (result.status === "client_rejected") {
    await deps.managedOAuthClientRegistry.markStale(
      served.grant.issuer,
      served.grant.clientId,
    );
  }
  return unwrap(
    await getDb().transaction((tx) =>
      commitRefresh(input, served, result, deps, tx),
    ),
  );
};

/**
 * Internal (decisions 12–15): the access token for the grant a `ready` or
 * `ready_with_pending_reconnect` connection serves, refreshed first when it
 * expires within 60 s. One refresh per connection is claimed in Postgres
 * before the token request is sent outside any transaction; a caller that
 * finds a fresh claim gets `MANAGED_CONNECTION_REFRESH_BUSY` at once, and a
 * claim older than `MANAGED_REFRESH_STALE_MS` moves the connection to
 * `reconnect_required` without refreshing. The refresh result is committed
 * only if the connection, grant and claim are unchanged
 * (`MANAGED_CONNECTION_CHANGED` otherwise). Failures that change state are
 * committed before the error is thrown. A grant issued for another resource
 * than the connection's is refused with `MANAGED_CONNECTION_GRANT_MISMATCH`
 * before any refresh or use. No route calls this directly.
 */
export const acquireManagedAccessToken = (
  input: AcquireManagedAccessTokenInput,
  deps: AcquireManagedAccessTokenDeps,
): Promise<ManagedAccessToken> => acquire(input, { kind: "acquire" }, deps);

/**
 * As {@link acquireManagedAccessToken}, for an MCP server that rejected a
 * token we believed valid: refreshes only while `rejectedAccessToken` is
 * still the stored one, so two rejections of the same token refresh once.
 */
export const forceRefreshManagedAccessToken = (
  input: ForceRefreshManagedAccessTokenInput,
  deps: AcquireManagedAccessTokenDeps,
): Promise<ManagedAccessToken> =>
  acquire(
    input,
    { kind: "force", rejectedAccessToken: input.rejectedAccessToken },
    deps,
  );
