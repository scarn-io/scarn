import type { Logger } from "@scarn/observability/logging";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { MANAGED_CONNECTION_RETENTION_MS } from "../domain/managed-connection-lapse";
import { MANAGED_OAUTH_ATTEMPT_TTL_MS } from "../domain/managed-oauth-attempt-entity";
import {
  expireLapsedManagedConnection,
  type ExpireLapsedManagedConnectionDeps,
} from "./expire-lapsed-managed-connection";
import type { ManagedOAuthAttemptRepo } from "./managed-oauth-attempt-repo";
import type { ManagedLaunchRepo } from "./managed-launch-repo";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_BATCHES = 50;

export type SweepManagedConnectionLeftoversDeps =
  ExpireLapsedManagedConnectionDeps & {
    managedOAuthAttemptRepo: ManagedOAuthAttemptRepo;
    managedLaunchRepo: ManagedLaunchRepo;
    timeProvider: TimeProvider;
    logger?: Logger | undefined;
    /** Rows handled per batch. Defaults to 100. */
    batchSize?: number | undefined;
    /** Max batches per pass. Defaults to 50. */
    maxBatches?: number | undefined;
  };

export type SweepManagedConnectionLeftoversResult = {
  attemptsExpired: number;
  candidatesExpired: number;
  grantsDeleted: number;
  eventsDeleted: number;
  launchesClosed: number;
  launchesDeleted: number;
};

/**
 * SCHEDULED maintenance use case (no auth actor) for decisions 7 and 11.
 * In bounded batches it:
 * - expires authorization attempts past their 10-minute window, dropping
 *   their PKCE verifier ciphertext (an `exchanging` attempt gets the same
 *   window again from when its exchange began);
 * - expires lapsed connects and candidates through the connection's
 *   `expire`, with compare-and-set under the row lock, then deletes the
 *   candidate grant row and its ciphertext; active grants are never touched;
 * - deletes grants retired more than 30 days ago;
 * - deletes connection events older than 30 days;
 * - closes launches whose runs are terminal (including expired run clocks);
 * - deletes closed launches and operations once a recorded run outcome is
 *   older than 30 days. Unknown operations of unfinished runs are retained.
 * Idempotent: a second run finds nothing left to do. Reads and confirm treat
 * lapsed rows as expired on their own, so correctness doesn't depend on it.
 */
export const sweepManagedConnectionLeftovers = async (
  deps: SweepManagedConnectionLeftoversDeps,
): Promise<SweepManagedConnectionLeftoversResult> => {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = deps.maxBatches ?? DEFAULT_MAX_BATCHES;
  const now = deps.timeProvider.now();
  const lapsedBefore = new Date(now.getTime() - MANAGED_OAUTH_ATTEMPT_TTL_MS);
  const retainedSince = new Date(
    now.getTime() - MANAGED_CONNECTION_RETENTION_MS,
  );

  let attemptsExpired = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const lapsed = await deps.managedOAuthAttemptRepo.listLapsedOpen({
      now,
      exchangingBefore: lapsedBefore,
      limit: batchSize,
    });
    for (const attempt of lapsed) {
      if (
        await deps.managedOAuthAttemptRepo.saveIfStatus(
          attempt.expire(now),
          attempt.status,
        )
      ) {
        attemptsExpired++;
      }
    }
    if (lapsed.length < batchSize) {
      break;
    }
  }

  let candidatesExpired = 0;
  let afterId: UuidV7 | null = null;
  for (let batch = 0; batch < maxBatches; batch++) {
    const lapsed = await deps.managedConnectionRepo.listLapsed({
      startedBefore: lapsedBefore,
      afterId,
      limit: batchSize,
    });
    for (const { projectId, connectionId } of lapsed) {
      afterId = connectionId;
      try {
        const expired = await getDb().transaction(async (tx) => {
          const connection = await deps.managedConnectionRepo.loadForUpdate(
            projectId,
            connectionId,
            tx,
          );
          return connection
            ? await expireLapsedManagedConnection(connection, now, deps, tx)
            : null;
        });
        if (expired?.candidateExpired) {
          candidatesExpired++;
        }
      } catch (error) {
        deps.logger?.warn(
          { projectId, connectionId, error },
          "Could not expire a lapsed managed connection; will retry next sweep",
        );
      }
    }
    if (lapsed.length < batchSize) {
      break;
    }
  }

  const drain = async (
    deleteBatch: (limit: number) => Promise<number>,
  ): Promise<number> => {
    let deleted = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const count = await deleteBatch(batchSize);
      deleted += count;
      if (count < batchSize) {
        break;
      }
    }
    return deleted;
  };
  const grantsDeleted = await drain(
    async (limit) =>
      await deps.managedOAuthGrantRepo.deleteRetiredBefore({
        retiredBefore: retainedSince,
        limit,
      }),
  );
  const eventsDeleted = await drain(
    async (limit) =>
      await deps.managedConnectionEventRepo.deleteCreatedBefore({
        createdBefore: retainedSince,
        limit,
      }),
  );
  const launchesClosed = await drain(
    async (limit) =>
      await deps.managedLaunchRepo.closeTerminalLaunches({ now, limit }),
  );
  const launchesDeleted = await drain(
    async (limit) =>
      await deps.managedLaunchRepo.deleteEndedRunLaunchesBefore({
        endedBefore: retainedSince,
        limit,
      }),
  );

  const result = {
    attemptsExpired,
    candidatesExpired,
    grantsDeleted,
    eventsDeleted,
    launchesClosed,
    launchesDeleted,
  };
  if (Object.values(result).some((count) => count > 0)) {
    deps.logger?.info(result, "Swept managed connection leftovers");
  }
  return result;
};
