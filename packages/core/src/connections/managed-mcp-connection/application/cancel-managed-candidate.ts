import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { getDb } from "@scarn/core/lib/db";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type {
  CancelManagedCandidateInput,
  ManagedConnectionContract,
} from "../contracts/managed-connection-contracts";
import { createManagedConnectionEvent } from "../domain/managed-connection-event";
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
import type { ManagedConnectionRepo } from "./managed-connection-repo";

type CancelManagedCandidateArgs = {
  projectId: UuidV7;
  connectionId: UuidV7;
  cancellation: CancelManagedCandidateInput;
};

type CancelManagedCandidateDeps = ManagedConnectionContractMapperDeps & {
  userAuthz: UserAuthorizationService;
  managedConnectionRepo: ManagedConnectionRepo;
  managedConnectionEventRepo: ManagedConnectionEventRepo;
  timeProvider: TimeProvider;
};

/**
 * Discards a candidate grant: the connection drops its pointer and the grant
 * row, with its ciphertext, is deleted. Nothing is revoked at the provider
 * (decision 16); an active grant, if any, keeps serving. Requires
 * `secrets:write`.
 */
export const cancelManagedCandidate = async (
  input: CancelManagedCandidateArgs,
  deps: CancelManagedCandidateDeps,
): Promise<ManagedConnectionContract> => {
  const { candidateId } = input.cancellation;
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
    const now = deps.timeProvider.now();
    const cancelled = connection.cancelCandidate(candidateId, now);
    if (
      !(await deps.managedConnectionRepo.saveIfVersion(
        cancelled,
        connection.version,
        tx,
      ))
    ) {
      throw managedConnectionVersionConflict();
    }
    await deps.managedOAuthGrantRepo.delete(
      connection.projectId,
      connection.id,
      candidateId,
      tx,
    );
    await deps.managedConnectionEventRepo.append(
      createManagedConnectionEvent({
        projectId: cancelled.projectId,
        connectionId: cancelled.id,
        actorUserId: deps.userAuthz.actorId,
        type: "candidate_cancelled",
        generation: cancelled.generation,
        createdAt: now,
      }),
      tx,
    );
    return await managedConnectionToContract(cancelled, deps, tx);
  });
};
