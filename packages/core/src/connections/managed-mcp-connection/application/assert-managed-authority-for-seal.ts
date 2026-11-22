import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreError } from "@scarn/core/lib/errors";
import type { NamedError } from "@scarn/core/tasks/task/domain/run-error";
import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import { createManagedConnectionEvent } from "../domain/managed-connection-event";
import {
  decideSealAuthority,
  managedAuthorityLostError,
  type ManagedAuthorityLoss,
  type ManagedSealAuthorityCheck,
  type ManagedSealBlockCode,
} from "../domain/managed-seal-authority";
import type { ManagedConnectionEventRepo } from "./managed-connection-event-repo";
import type { ManagedLaunchRepo } from "./managed-launch-repo";
import {
  readManagedAuthorityChecks,
  type ReadManagedAuthorityChecksDeps,
} from "./read-managed-authority-checks";

export type AssertManagedAuthorityForSealDeps = ReadManagedAuthorityChecksDeps & {
  managedLaunchRepo: Pick<
    ManagedLaunchRepo,
    "listOpenForRun" | "lockOperationsForSeal"
  >;
  managedConnectionEventRepo: Pick<ManagedConnectionEventRepo, "append">;
};

const blockMessages: Record<ManagedSealBlockCode, string> = {
  MANAGED_OPERATION_IN_FLIGHT:
    "A managed connection call of this run is still in flight. Retry once it ends.",
  MANAGED_CONNECTION_REFRESH_PENDING:
    "A managed connection this run uses is refreshing its credentials. Retry shortly.",
};

const sealBlocked = (code: ManagedSealBlockCode) =>
  new CoreError({
    code,
    message: blockMessages[code],
    status: 409,
    meta: { retryAfterSeconds: 1 },
  });

const recordLosses = async (
  run: TaskRunEntity,
  checks: readonly ManagedSealAuthorityCheck[],
  losses: readonly ManagedAuthorityLoss[],
  now: Date,
  deps: AssertManagedAuthorityForSealDeps,
  tx: DbExecutor,
): Promise<void> => {
  const recorded = new Set<string>();
  for (const loss of losses) {
    const connection = checks.find(
      (check) => check.launch.id === loss.launchConnectionId,
    )?.connection;
    if (!connection || recorded.has(connection.id)) {
      continue;
    }
    recorded.add(connection.id);
    await deps.managedConnectionEventRepo.append(
      createManagedConnectionEvent({
        projectId: connection.projectId,
        connectionId: connection.id,
        actorUserId: null,
        taskRunId: run.id,
        type: "authority_lost",
        reasonCode: loss.reason,
        generation: connection.generation,
        createdAt: now,
      }),
      tx,
    );
  }
};

/**
 * The authority fence (decisions 3, 4, 9, 15, 16), run at a seal
 * (completion or yield) inside the transaction that already locks `run`, so
 * the lock order is run, then connection (decision 10). A run with no open
 * launch connection costs one query.
 *
 * It takes every pinned connection `FOR SHARE`, the lock disconnect,
 * confirm, `requireReconnect` and refresh claims wait on, then locks the
 * launch rows and reads their operations; whichever of the seal and an
 * authority move commits first wins. It then decides with
 * `decideSealAuthority`:
 * - authority lost: appends one `authority_lost` event per affected
 *   connection and returns the `ManagedConnectionAuthorityLost` error the
 *   caller fails the run with, applying nothing it reported;
 * - blocked: throws a 409 (`MANAGED_OPERATION_IN_FLIGHT` or
 *   `MANAGED_CONNECTION_REFRESH_PENDING`) that rolls the seal back, for the
 *   worker to retry;
 * - authorized: returns null.
 */
export const assertManagedAuthorityForSeal = async (
  run: TaskRunEntity,
  now: Date,
  deps: AssertManagedAuthorityForSealDeps,
  tx: DbExecutor,
): Promise<NamedError | null> => {
  const checks = await readManagedAuthorityChecks(run, deps, tx);
  if (checks.length === 0) {
    return null;
  }
  const operations = await deps.managedLaunchRepo.lockOperationsForSeal(
    run.id,
    tx,
  );
  const decision = decideSealAuthority(checks, operations, now);
  switch (decision.kind) {
    case "authorized":
      return null;
    case "blocked":
      throw sealBlocked(decision.code);
    case "lost":
      await recordLosses(run, checks, decision.losses, now, deps, tx);
      return managedAuthorityLostError(decision.losses);
  }
};
