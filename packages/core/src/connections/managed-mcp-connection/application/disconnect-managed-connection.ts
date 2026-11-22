import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { getDb } from "@scarn/core/lib/db";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { DisconnectManagedConnectionResponse } from "../contracts/managed-connection-contracts";
import {
  createManagedConnectionEvent,
  type ManagedRevocationOutcome,
} from "../domain/managed-connection-event";
import type { ManagedOAuthGrantEntity } from "../domain/managed-oauth-grant-entity";
import {
  managedConnectionNotFound,
  managedConnectionVersionConflict,
  requireConnectionWriter,
} from "./managed-connection-access";
import {
  managedConnectionToContract,
  type ManagedConnectionContractMapperDeps,
} from "./managed-connection-contract-mapper";
import type { ManagedConnectionEventRepo } from "./managed-connection-event-repo";
import type { ManagedConnectionPresets } from "./managed-connection-preset";
import type { ManagedConnectionRepo } from "./managed-connection-repo";
import type { ManagedGrantCredentials } from "./managed-grant-crypto";
import type { ManagedOAuthAttemptRepo } from "./managed-oauth-attempt-repo";
import type { ManagedOAuthProviders } from "./managed-oauth-providers";
import { cancelOpenManagedOAuthAttempts } from "./open-managed-oauth-attempt";

type DisconnectManagedConnectionInput = {
  projectId: UuidV7;
  connectionId: UuidV7;
};

type DisconnectManagedConnectionDeps = ManagedConnectionContractMapperDeps & {
  userAuthz: UserAuthorizationService;
  managedConnectionRepo: ManagedConnectionRepo;
  managedOAuthAttemptRepo: ManagedOAuthAttemptRepo;
  managedConnectionEventRepo: ManagedConnectionEventRepo;
  managedOAuthProviders: ManagedOAuthProviders;
  managedConnectionPresets: ManagedConnectionPresets;
  timeProvider: TimeProvider;
};

type Revocable = {
  grant: ManagedOAuthGrantEntity;
  credentials: ManagedGrantCredentials;
};

/**
 * Disconnects a connection (decision 6). In one transaction, under the
 * connection's row lock: the active grant's credentials are decrypted into
 * memory, the active grant is retired (credential ciphertext deleted, identity
 * kept until the retention sweep), an unconfirmed candidate is deleted
 * outright, open attempts are cancelled, and the connection becomes a
 * `disconnected` tombstone at a new `generation`, so an in-flight callback
 * can no longer attach. After commit, one revocation request is sent with
 * the in-memory credentials and its outcome is recorded as a second event.
 * `revocation` is null when there was no active grant. `providerRemovalUrl`
 * comes from the connection's preset, if it has one. Disconnecting a
 * connection that is already disconnected is
 * `MANAGED_CONNECTION_STATE_CONFLICT` (409). Requires `secrets:write`.
 */
export const disconnectManagedConnection = async (
  input: DisconnectManagedConnectionInput,
  deps: DisconnectManagedConnectionDeps,
): Promise<DisconnectManagedConnectionResponse> => {
  await requireConnectionWriter(deps.userAuthz, input.projectId);

  const { disconnected, revocable } = await getDb().transaction(async (tx) => {
    await requireConnectionWriter(deps.userAuthz, input.projectId, tx);
    const connection = await deps.managedConnectionRepo.loadForUpdate(
      input.projectId,
      input.connectionId,
      tx,
    );
    if (!connection) {
      throw managedConnectionNotFound(input.connectionId);
    }
    const now = deps.timeProvider.now();
    const next = connection.disconnect(now);

    const activeGrantId =
      "activeGrantId" in connection ? connection.activeGrantId : null;
    const active =
      activeGrantId === null
        ? null
        : await deps.managedOAuthGrantRepo.findById(
            connection.projectId,
            connection.id,
            activeGrantId,
            tx,
          );
    let held: Revocable | null = null;
    if (active?.credentials.status === "live") {
      held = {
        grant: active,
        credentials: deps.managedGrantCrypto.decryptCredentials(
          {
            projectId: active.projectId,
            connectionId: active.connectionId,
            grantId: active.id,
            credentialVersion: active.credentialVersion,
          },
          active.credentials.encryptedCredentials,
        ),
      };
    }

    if (
      !(await deps.managedConnectionRepo.saveIfVersion(
        next,
        connection.version,
        tx,
      ))
    ) {
      throw managedConnectionVersionConflict();
    }
    if (active) {
      await deps.managedOAuthGrantRepo.save(active.retire(now), tx);
    }
    const candidateGrantId = connection.pendingCandidateGrantId;
    if (candidateGrantId !== null) {
      await deps.managedOAuthGrantRepo.delete(
        connection.projectId,
        connection.id,
        candidateGrantId,
        tx,
      );
    }
    await cancelOpenManagedOAuthAttempts(
      connection,
      deps.managedOAuthAttemptRepo,
      now,
      tx,
    );
    await deps.managedConnectionEventRepo.append(
      createManagedConnectionEvent({
        projectId: next.projectId,
        connectionId: next.id,
        actorUserId: deps.userAuthz.actorId,
        type: "disconnected",
        generation: next.generation,
        createdAt: now,
      }),
      tx,
    );
    return { disconnected: next, revocable: held };
  });

  let revocation: ManagedRevocationOutcome | null = null;
  if (revocable) {
    try {
      revocation = await deps.managedOAuthProviders
        .for(disconnected)
        .revoke(revocable);
    } catch {
      revocation = "unconfirmed";
    }
    await deps.managedConnectionEventRepo.append(
      createManagedConnectionEvent({
        projectId: disconnected.projectId,
        connectionId: disconnected.id,
        actorUserId: deps.userAuthz.actorId,
        type: "revocation_attempted",
        generation: disconnected.generation,
        revocationOutcome: revocation,
        createdAt: deps.timeProvider.now(),
      }),
    );
  }

  return {
    connection: await managedConnectionToContract(disconnected, deps),
    revocation,
    providerRemovalUrl:
      (disconnected.preset === null
        ? null
        : deps.managedConnectionPresets.get(disconnected.preset)?.removalUrl) ??
      null,
  };
};
