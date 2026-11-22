/**
 * Keeps only the saved agent sessions that can still be restored, and meters
 * them. A Task keeps at most its latest run's session (a continuation only
 * ever restores the immediately previous run's export), and none once it
 * ends. Yield-time meter updates are estimates; the daily reconciliation
 * recounts `session_size_bytes` and overwrites them.
 */
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor, DbTransaction } from "@scarn/core/lib/db/db-executor";
import type { DomainEvent } from "@scarn/core/lib/domain-events/domain-event";
import type { InMemoryDomainEventDispatcher } from "@scarn/core/lib/domain-events/in-memory-domain-event-dispatcher";
import type { Logger } from "@scarn/observability/logging";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import type { TaskRunEntity } from "../domain/task-run-entity";
import { SessionSavedDomainEvent } from "../domain/session-saved.domain-event";
import { SessionsReleasedDomainEvent } from "../domain/sessions-released.domain-event";
import type { EndedTaskSessions } from "./delete-task-sessions";
import type { TaskRunRepo } from "./task-run-repo";

export type TaskRunSessionsDeps = {
  taskRunRepo: Pick<TaskRunRepo, "clearSessions">;
  orgRepo?: Pick<OrgRepo, "findByProjectId"> | undefined;
  domainEventDispatcher?: InMemoryDomainEventDispatcher | undefined;
  logger?: Logger | undefined;
};

/**
 * Publishes usage events in a savepoint of `tx`, so a metering failure is
 * logged and rolled back without failing the operation that stored the
 * session. Skipped when no org repo or dispatcher is wired.
 */
const publishUsage = async (
  projectId: UuidV7,
  toEvents: (orgId: UuidV7) => DomainEvent[],
  deps: TaskRunSessionsDeps,
  tx: DbExecutor,
): Promise<void> => {
  const { orgRepo, domainEventDispatcher, logger } = deps;
  if (!orgRepo || !domainEventDispatcher) {
    return;
  }
  try {
    await tx.transaction(async (savepoint: DbTransaction) => {
      const org = await orgRepo.findByProjectId(projectId, savepoint);
      if (org) {
        await domainEventDispatcher.publish(toEvents(org.id), savepoint);
      }
    });
  } catch (error) {
    logger?.error({ projectId, error }, "Failed to meter agent session usage");
  }
};

/** Meters the session a yield of `run` attached: one write plus its bytes. */
export const recordSessionSaved = async (
  run: TaskRunEntity,
  deps: TaskRunSessionsDeps,
  tx: DbExecutor,
): Promise<void> => {
  if (!run.sessionObjectKey) {
    return;
  }
  await publishUsage(
    run.projectId,
    (orgId) => [
      new SessionSavedDomainEvent({
        orgId,
        projectId: run.projectId,
        taskRunId: run.id,
        sizeBytes: run.sessionSizeBytes ?? 0,
      }),
    ],
    deps,
    tx,
  );
};

/**
 * Stops keeping the saved sessions of `runs`: clears their session columns,
 * subtracts their bytes from the meter and adds their object keys to
 * `endedTaskSessions` for deletion after commit. Runs without a session are
 * ignored. Every run must belong to the same project.
 */
export const releaseTaskRunSessions = async (
  runs: TaskRunEntity[],
  deps: TaskRunSessionsDeps & {
    endedTaskSessions?: EndedTaskSessions | undefined;
  },
  tx: DbExecutor,
): Promise<void> => {
  const withSession = runs.filter((run) => run.sessionObjectKey);
  const first = withSession[0];
  if (!first) {
    return;
  }
  await deps.taskRunRepo.clearSessions(
    withSession.map((run) => run.id),
    tx,
  );
  for (const run of withSession) {
    if (run.sessionObjectKey) {
      deps.endedTaskSessions?.add(run.sessionObjectKey);
    }
  }
  const sizeBytes = withSession.reduce(
    (total, run) => total + (run.sessionSizeBytes ?? 0),
    0,
  );
  if (sizeBytes === 0) {
    return;
  }
  await publishUsage(
    first.projectId,
    (orgId) => [
      new SessionsReleasedDomainEvent({
        orgId,
        projectId: first.projectId,
        taskRunIds: withSession.map((run) => run.id),
        sizeBytes,
      }),
    ],
    deps,
    tx,
  );
};
