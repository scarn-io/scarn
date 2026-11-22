import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { createManagedConnectionEvent } from "../domain/managed-connection-event";
import { managedConnectionVersionConflict } from "./managed-connection-access";
import type { ManagedConnectionEventRepo } from "./managed-connection-event-repo";
import type { ManagedConnectionRepo } from "./managed-connection-repo";
import type { ManagedOAuthAttemptRepo } from "./managed-oauth-attempt-repo";
import type { ManagedOAuthGrantRepo } from "./managed-oauth-grant-repo";

export type CancelManagedConsentForActorDeps = {
  managedConnectionRepo: ManagedConnectionRepo;
  managedOAuthAttemptRepo: ManagedOAuthAttemptRepo;
  managedOAuthGrantRepo: ManagedOAuthGrantRepo;
  managedConnectionEventRepo: ManagedConnectionEventRepo;
  timeProvider: TimeProvider;
};

/**
 * Cancels only the affected actor's unconfirmed consent, never active grants.
 * The caller must already hold the project row FOR UPDATE and persist the
 * permission change in this same transaction. Connection locks follow in ID
 * order; no run locks or provider calls are made.
 */
export const cancelManagedConsentForActor = async (
  input: { projectId: UuidV7; userId: UuidV7 },
  deps: CancelManagedConsentForActorDeps,
  tx: DbExecutor,
): Promise<void> => {
  const connections = await deps.managedConnectionRepo.listByProject(
    input.projectId,
    tx,
  );
  connections.sort((left, right) => left.id.localeCompare(right.id));

  for (const listed of connections) {
    const connection = await deps.managedConnectionRepo.loadForUpdate(
      input.projectId,
      listed.id,
      tx,
    );
    if (!connection) continue;
    const now = deps.timeProvider.now();

    for (const attempt of await deps.managedOAuthAttemptRepo.listOpenByConnection(
      input.projectId,
      connection.id,
      tx,
    )) {
      if (attempt.actorUserId !== input.userId) continue;
      if (
        await deps.managedOAuthAttemptRepo.saveIfStatus(
          attempt.cancel(now),
          attempt.status,
          tx,
        )
      ) {
        await deps.managedConnectionEventRepo.append(
          createManagedConnectionEvent({
            projectId: input.projectId,
            connectionId: connection.id,
            actorUserId: input.userId,
            type: "attempt_failed",
            generation: attempt.expectedGeneration,
            reasonCode: "permission_revoked",
            createdAt: now,
          }),
          tx,
        );
      }
    }

    const candidateId = connection.pendingCandidateGrantId;
    if (!candidateId) continue;
    const candidate = await deps.managedOAuthGrantRepo.findById(
      input.projectId,
      connection.id,
      candidateId,
      tx,
    );
    if (!candidate || candidate.createdByUserId !== input.userId) continue;

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
      input.projectId,
      connection.id,
      candidateId,
      tx,
    );
    await deps.managedConnectionEventRepo.append(
      createManagedConnectionEvent({
        projectId: input.projectId,
        connectionId: connection.id,
        actorUserId: input.userId,
        type: "candidate_cancelled",
        generation: cancelled.generation,
        reasonCode: "permission_revoked",
        createdAt: now,
      }),
      tx,
    );
  }
};
