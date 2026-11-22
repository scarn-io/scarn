import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { getDb } from "@scarn/core/lib/db";
import { CoreError } from "@scarn/core/lib/errors";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type {
  ConfirmManagedCandidateInput,
  ManagedConnectionContract,
} from "../contracts/managed-connection-contracts";
import { managedConnectionCandidateMismatch } from "../domain/managed-connection-entity";
import { createManagedConnectionEvent } from "../domain/managed-connection-event";
import { managedCandidateExpiresAt } from "../domain/managed-connection-lapse";
import {
  managedConnectionNotFound,
  managedConnectionVersionConflict,
  requireConnectionWriter,
} from "./managed-connection-access";
import {
  managedConnectionToContract,
  managedGrantFingerprint,
  managedGrantsSameIdentity,
  type ManagedConnectionContractMapperDeps,
} from "./managed-connection-contract-mapper";
import type { ManagedConnectionEventRepo } from "./managed-connection-event-repo";
import type { ManagedConnectionRepo } from "./managed-connection-repo";
import type { ManagedOAuthAttemptRepo } from "./managed-oauth-attempt-repo";

type ConfirmManagedCandidateArgs = {
  projectId: UuidV7;
  connectionId: UuidV7;
  confirmation: ConfirmManagedCandidateInput;
};

type ConfirmManagedCandidateDeps = ManagedConnectionContractMapperDeps & {
  userAuthz: UserAuthorizationService;
  managedConnectionRepo: ManagedConnectionRepo;
  managedOAuthAttemptRepo: ManagedOAuthAttemptRepo;
  managedConnectionEventRepo: ManagedConnectionEventRepo;
  timeProvider: TimeProvider;
};

const candidateExpired = () =>
  new CoreError({
    code: "MANAGED_CANDIDATE_EXPIRED",
    message: "This connection request has expired. Connect again.",
    status: 409,
  });

/**
 * Activates the candidate grant the person was shown. They must present the
 * candidate's ID and fingerprint and the connection version they saw; under
 * the connection's row lock, the actor's `secrets:write`, the version, the
 * candidate's 10-minute window and the attempt that produced it (still
 * succeeded, at the current generation) are all checked again. A replaced
 * grant is retired locally (its credential ciphertext deleted, its identity
 * kept until the retention sweep) and never revoked at the provider
 * (decision 16); the event records whether the new grant acts as the same
 * account.
 */
export const confirmManagedCandidate = async (
  input: ConfirmManagedCandidateArgs,
  deps: ConfirmManagedCandidateDeps,
): Promise<ManagedConnectionContract> => {
  const { candidateId, fingerprint, expectedVersion } = input.confirmation;
  await requireConnectionWriter(deps.userAuthz, input.projectId);

  return await getDb().transaction(async (tx) => {
    await requireConnectionWriter(deps.userAuthz, input.projectId, tx);
    const connection = await deps.managedConnectionRepo.loadForUpdate(
      input.projectId,
      input.connectionId,
      tx,
    );
    if (!connection) {
      throw managedConnectionNotFound(input.connectionId);
    }
    if (connection.version !== expectedVersion) {
      throw managedConnectionVersionConflict();
    }
    if (connection.pendingCandidateGrantId !== candidateId) {
      throw managedConnectionCandidateMismatch();
    }

    const now = deps.timeProvider.now();
    const candidate = await deps.managedOAuthGrantRepo.findById(
      connection.projectId,
      connection.id,
      candidateId,
      tx,
    );
    const attempt = await deps.managedOAuthAttemptRepo.findByCandidateGrant(
      connection.projectId,
      candidateId,
      tx,
    );
    if (
      !candidate ||
      candidate.isRetired ||
      attempt?.progress.status !== "succeeded" ||
      attempt.expectedGeneration !== connection.generation
    ) {
      throw managedConnectionCandidateMismatch();
    }
    if (now.getTime() >= managedCandidateExpiresAt(candidate).getTime()) {
      throw candidateExpired();
    }

    const identity = deps.managedGrantCrypto.decryptIdentity(
      {
        projectId: candidate.projectId,
        connectionId: candidate.connectionId,
        grantId: candidate.id,
      },
      candidate.encryptedIdentity,
    );
    const previousGrantId =
      "activeGrantId" in connection ? connection.activeGrantId : null;
    const confirmed = connection.confirmCandidate(candidateId, fingerprint, {
      candidateFingerprint: managedGrantFingerprint(candidate, identity),
      confirmedByUserId: deps.userAuthz.actorId,
      now,
    });
    if (
      !(await deps.managedConnectionRepo.saveIfVersion(
        confirmed,
        connection.version,
        tx,
      ))
    ) {
      throw managedConnectionVersionConflict();
    }
    let sameIdentityAsActive: boolean | null = null;
    if (previousGrantId !== null && previousGrantId !== candidateId) {
      const previous = await deps.managedOAuthGrantRepo.findById(
        connection.projectId,
        connection.id,
        previousGrantId,
        tx,
      );
      if (previous) {
        const same = managedGrantsSameIdentity(
          { grant: candidate, identity },
          {
            grant: previous,
            identity: deps.managedGrantCrypto.decryptIdentity(
              {
                projectId: previous.projectId,
                connectionId: previous.connectionId,
                grantId: previous.id,
              },
              previous.encryptedIdentity,
            ),
          },
        );
        sameIdentityAsActive = same === "unknown" ? null : same;
        await deps.managedOAuthGrantRepo.save(previous.retire(now), tx);
      }
    }
    await deps.managedConnectionEventRepo.append(
      createManagedConnectionEvent({
        projectId: confirmed.projectId,
        connectionId: confirmed.id,
        actorUserId: deps.userAuthz.actorId,
        type: "candidate_confirmed",
        generation: confirmed.generation,
        sameIdentityAsActive,
        createdAt: now,
      }),
      tx,
    );
    return await managedConnectionToContract(confirmed, deps, tx);
  });
};
