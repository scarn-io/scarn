import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { InvariantViolationError } from "@scarn/core/lib/errors";
import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type { ManagedConnectionEntity } from "../domain/managed-connection-entity";
import type { ManagedSealAuthorityCheck } from "../domain/managed-seal-authority";
import type { ManagedConnectionRepo } from "./managed-connection-repo";
import type { ManagedLaunchRepo } from "./managed-launch-repo";
import type { ManagedOAuthGrantRepo } from "./managed-oauth-grant-repo";

export type ReadManagedAuthorityChecksDeps = {
  managedLaunchRepo: Pick<ManagedLaunchRepo, "listOpenForRun">;
  managedConnectionRepo: Pick<ManagedConnectionRepo, "loadForShare">;
  managedOAuthGrantRepo: Pick<ManagedOAuthGrantRepo, "findById">;
};

/**
 * Reads what the authority fence checks for `run`: takes each distinct
 * pinned connection `FOR SHARE`, in ID order, and reads the serving grant of
 * every launch the connection still authorizes. A run with no open launch
 * connection costs one query.
 */
export const readManagedAuthorityChecks = async (
  run: Pick<TaskRunEntity, "id" | "projectId">,
  deps: ReadManagedAuthorityChecksDeps,
  tx: DbExecutor,
): Promise<ManagedSealAuthorityCheck[]> => {
  const launches = await deps.managedLaunchRepo.listOpenForRun(run.id, tx);
  const connectionIds = [
    ...new Set(launches.map((launch) => launch.connectionId)),
  ].sort();
  const connections = new Map<string, ManagedConnectionEntity | null>();
  for (const connectionId of connectionIds) {
    connections.set(
      connectionId,
      await deps.managedConnectionRepo.loadForShare(
        run.projectId,
        connectionId,
        tx,
      ),
    );
  }
  const checks: ManagedSealAuthorityCheck[] = [];
  for (const launch of launches) {
    const connection = connections.get(launch.connectionId) ?? null;
    if (connection === null || !launch.isAuthorizedBy(connection)) {
      checks.push({ launch, connection, servingGrant: null });
      continue;
    }
    const servingGrant = await deps.managedOAuthGrantRepo.findById(
      run.projectId,
      connection.id,
      launch.grantId,
      tx,
    );
    if (!servingGrant) {
      throw new InvariantViolationError(
        `Managed connection ${connection.id} serves grant ${launch.grantId}, which is missing`,
      );
    }
    checks.push({ launch, connection, servingGrant });
  }
  return checks;
};
