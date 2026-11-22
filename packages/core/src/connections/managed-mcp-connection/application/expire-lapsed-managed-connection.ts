import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { ManagedConnectionEntity } from "../domain/managed-connection-entity";
import { createManagedConnectionEvent } from "../domain/managed-connection-event";
import { lapseManagedConnection } from "../domain/managed-connection-lapse";
import { managedConnectionVersionConflict } from "./managed-connection-access";
import type { ManagedConnectionEventRepo } from "./managed-connection-event-repo";
import type { ManagedConnectionRepo } from "./managed-connection-repo";
import type { ManagedOAuthGrantRepo } from "./managed-oauth-grant-repo";

export type ExpireLapsedManagedConnectionDeps = {
  managedConnectionRepo: ManagedConnectionRepo;
  managedOAuthGrantRepo: ManagedOAuthGrantRepo;
  managedConnectionEventRepo: ManagedConnectionEventRepo;
};

/**
 * Inside the caller's transaction, with `connection` locked: writes the
 * expiry reads already show (see `lapseManagedConnection`). An expired
 * candidate's grant row, with its ciphertext, is deleted after the
 * connection drops its pointer; the active grant is never touched. Returns
 * the expired connection, or null when nothing had lapsed.
 */
export const expireLapsedManagedConnection = async (
  connection: ManagedConnectionEntity,
  now: Date,
  deps: ExpireLapsedManagedConnectionDeps,
  dbExecutor: DbExecutor,
): Promise<{
  connection: ManagedConnectionEntity;
  candidateExpired: boolean;
} | null> => {
  const candidateGrantId = connection.pendingCandidateGrantId;
  const candidate =
    candidateGrantId === null
      ? null
      : await deps.managedOAuthGrantRepo.findById(
          connection.projectId,
          connection.id,
          candidateGrantId,
          dbExecutor,
        );
  const lapsed = lapseManagedConnection(connection, candidate, now);
  if (!lapsed) {
    return null;
  }
  if (
    !(await deps.managedConnectionRepo.saveIfVersion(
      lapsed.connection,
      connection.version,
      dbExecutor,
    ))
  ) {
    throw managedConnectionVersionConflict();
  }
  if (lapsed.candidateExpired && candidateGrantId !== null) {
    await deps.managedOAuthGrantRepo.delete(
      connection.projectId,
      connection.id,
      candidateGrantId,
      dbExecutor,
    );
    await deps.managedConnectionEventRepo.append(
      createManagedConnectionEvent({
        projectId: connection.projectId,
        connectionId: connection.id,
        actorUserId: null,
        type: "candidate_expired",
        generation: lapsed.connection.generation,
        createdAt: now,
      }),
      dbExecutor,
    );
  }
  return lapsed;
};
