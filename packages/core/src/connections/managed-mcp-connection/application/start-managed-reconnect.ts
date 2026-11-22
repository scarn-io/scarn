import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { getDb } from "@scarn/core/lib/db";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { randomOAuthToken } from "../domain/managed-oauth-digests";
import {
  managedConnectionNotFound,
  managedConnectionVersionConflict,
  requireConnectionWriter,
} from "./managed-connection-access";
import type { ManagedConnectionEventRepo } from "./managed-connection-event-repo";
import { expireLapsedManagedConnection } from "./expire-lapsed-managed-connection";
import type { ManagedConnectionRepo } from "./managed-connection-repo";
import type { ManagedGrantCrypto } from "./managed-grant-crypto";
import type { ManagedOAuthAttemptRepo } from "./managed-oauth-attempt-repo";
import type { ManagedOAuthClientRegistry } from "./managed-oauth-client-registry";
import type { ManagedOAuthGrantRepo } from "./managed-oauth-grant-repo";
import type { ManagedOAuthProviders } from "./managed-oauth-providers";
import {
  cancelOpenManagedOAuthAttempts,
  openManagedOAuthAttempt,
  prepareManagedOAuthBinding,
  startManagedOAuthResponse,
  type ManagedOAuthStartBinding,
  type StartManagedOAuthResponse,
} from "./open-managed-oauth-attempt";

type StartManagedReconnectInput<B extends ManagedOAuthStartBinding> = {
  projectId: UuidV7;
  connectionId: UuidV7;
  /** Who finishes the attempt: the starting browser session, or the CLI on a loopback redirect. */
  binding: B;
};

type StartManagedReconnectDeps = {
  userAuthz: UserAuthorizationService;
  managedConnectionRepo: ManagedConnectionRepo;
  managedOAuthAttemptRepo: ManagedOAuthAttemptRepo;
  managedOAuthGrantRepo: ManagedOAuthGrantRepo;
  managedConnectionEventRepo: ManagedConnectionEventRepo;
  managedGrantCrypto: ManagedGrantCrypto;
  managedOAuthProviders: ManagedOAuthProviders;
  managedOAuthClientRegistry: ManagedOAuthClientRegistry;
  timeProvider: TimeProvider;
};

/**
 * Starts a reconnect of a connection that has a grant (`ready` or
 * `reconnect_required`). The active grant keeps its place until the candidate
 * the callback stores is confirmed (decision 5). A reconnect already in
 * flight is replaced, and a lapsed candidate is expired first; a connection
 * with an unconfirmed candidate, or without a grant, is
 * `MANAGED_CONNECTION_STATE_CONFLICT` (409). Requires `secrets:write`.
 */
export const startManagedReconnect = async <B extends ManagedOAuthStartBinding>(
  input: StartManagedReconnectInput<B>,
  deps: StartManagedReconnectDeps,
): Promise<StartManagedOAuthResponse<B>> => {
  await requireConnectionWriter(deps.userAuthz, input.projectId);
  const target = await deps.managedConnectionRepo.findById(
    input.projectId,
    input.connectionId,
  );
  if (!target) {
    throw managedConnectionNotFound(input.connectionId);
  }
  const prepared = prepareManagedOAuthBinding(
    input.binding,
    target,
    "reconnect",
  );
  const provider = deps.managedOAuthProviders.for(target);
  const metadata = await provider.discover();
  const client = await deps.managedOAuthClientRegistry.resolve(
    target.server,
    metadata,
    prepared.redirectUri,
  );

  const state = randomOAuthToken();
  const pkceVerifier = randomOAuthToken();
  const now = deps.timeProvider.now();

  const attempt = await getDb().transaction(async (tx) => {
    await requireConnectionWriter(deps.userAuthz, input.projectId, tx);
    const existing = await deps.managedConnectionRepo.loadForUpdate(
      input.projectId,
      input.connectionId,
      tx,
    );
    if (!existing) {
      throw managedConnectionNotFound(input.connectionId);
    }
    const current =
      (await expireLapsedManagedConnection(existing, now, deps, tx))
        ?.connection ?? existing;
    const connection = current.startReconnect(now);
    if (
      !(await deps.managedConnectionRepo.saveIfVersion(
        connection,
        current.version,
        tx,
      ))
    ) {
      throw managedConnectionVersionConflict();
    }
    await cancelOpenManagedOAuthAttempts(
      current,
      deps.managedOAuthAttemptRepo,
      now,
      tx,
    );
    return await openManagedOAuthAttempt(
      {
        connection,
        kind: "reconnect",
        client,
        requestedScopes: connection.server.scopes ?? metadata.scopesSupported,
        binding: prepared,
        state,
        pkceVerifier,
        now,
      },
      deps,
      tx,
    );
  });

  return startManagedOAuthResponse<B>(
    prepared,
    attempt,
    await provider.authorizationUrl({ attempt, state, pkceVerifier }),
  );
};
