import type { Logger } from "@scarn/observability/logging";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UserNotificationRepo } from "@scarn/core/notifications/user-notification/application/user-notification-repo";
import {
  deleteRunStorage,
  type DeleteRunStorageDeps,
} from "@scarn/core/tasks/storage-sweep/application/delete-run-storage";
import {
  scheduleStorageSweeps,
  type ScheduleStorageSweepsDeps,
} from "@scarn/core/tasks/storage-sweep/application/schedule-storage-sweeps";
import type { SweptRun } from "@scarn/core/tasks/storage-sweep/domain/storage-sweep";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import {
  releaseTaskRunSessions,
  type TaskRunSessionsDeps,
} from "@scarn/core/tasks/task-run/application/task-run-sessions";
import type { TaskRepo } from "@scarn/core/tasks/task/application/task-repo";
import {
  scheduledTaskRetentionPolicy,
  type PrunableScheduledTask,
} from "../domain/scheduled-task-retention";

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_BATCHES = 50;

export type PruneScheduledTasksDeps = ScheduleStorageSweepsDeps &
  Omit<TaskRunSessionsDeps, "taskRunRepo"> & {
    taskRepo: Pick<
      TaskRepo,
      "listPrunableScheduled" | "lockPrunableScheduled" | "deleteMany"
    >;
    taskRunRepo: Pick<TaskRunRepo, "listByTaskId"> &
      TaskRunSessionsDeps["taskRunRepo"];
    userNotificationRepo: Pick<UserNotificationRepo, "deleteByTaskIds">;
    objectStore: DeleteRunStorageDeps["objectStore"];
    timeProvider: TimeProvider;
    logger?: Logger | undefined;
    /** Tasks deleted per batch (one transaction each). Defaults to 100. */
    batchSize?: number | undefined;
    /** Max batches per invocation. Defaults to 50. */
    maxBatches?: number | undefined;
    /** Ended Tasks each schedule keeps; defaults to `SCHEDULED_TASK_RETENTION_COUNT`. */
    keepNewest?: number | undefined;
    dbExecutor?: DbExecutor | undefined;
  };

export type PruneScheduledTasksResult = {
  /** Tasks deleted. */
  deleted: number;
  /** Batches that deleted at least one Task. */
  batches: number;
};

const groupByProject = (tasks: PrunableScheduledTask[]) => {
  const byProject = new Map<UuidV7, UuidV7[]>();
  for (const task of tasks) {
    byProject.set(task.projectId, [
      ...(byProject.get(task.projectId) ?? []),
      task.id,
    ]);
  }
  return byProject;
};

/**
 * SCHEDULED maintenance use case (no auth actor): deletes the old, ended
 * Tasks schedules started, keeping what `scheduled-task-retention.ts` says to
 * keep. Oldest first, in bounded batches, each in one transaction that
 * follows the deletion contract (docs/adr/0003-conversation-deletion-contract.md):
 * a storage sweep per run, its saved sessions taken off the meter, the Task's
 * notifications, then the Tasks (with their runs, by cascade). After each
 * commit the runs' stored objects are deleted best-effort; the sweeps delete
 * them again later. Idempotent: a second call finds nothing more to delete.
 */
export const pruneScheduledTasks = async (
  deps: PruneScheduledTasksDeps,
): Promise<PruneScheduledTasksResult> => {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = deps.maxBatches ?? DEFAULT_MAX_BATCHES;
  const db = deps.dbExecutor ?? getDb();
  const policy = scheduledTaskRetentionPolicy(deps.timeProvider.now(), {
    ...(deps.keepNewest === undefined ? {} : { keepNewest: deps.keepNewest }),
  });

  const deleteBatch = async (candidates: PrunableScheduledTask[]) =>
    await db.transaction(async (tx) => {
      const locked = await deps.taskRepo.lockPrunableScheduled(
        candidates.map((task) => task.id),
        policy,
        tx,
      );
      const swept: SweptRun[] = [];
      for (const task of locked) {
        const runs = await deps.taskRunRepo.listByTaskId(task.id, tx);
        swept.push(
          ...runs.map((run) => ({
            projectId: run.projectId,
            taskRunId: run.id,
          })),
        );
        await releaseTaskRunSessions(runs, deps, tx);
      }
      await scheduleStorageSweeps(swept, deps, tx);
      for (const [projectId, taskIds] of groupByProject(locked)) {
        await deps.userNotificationRepo.deleteByTaskIds(
          { projectId, taskIds },
          tx,
        );
      }
      const deleted = await deps.taskRepo.deleteMany(
        locked.map((task) => task.id),
        tx,
      );
      return { deleted, swept };
    });

  let deleted = 0;
  let batches = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const candidates = await deps.taskRepo.listPrunableScheduled(
      policy,
      batchSize,
      db,
    );
    if (candidates.length === 0) {
      break;
    }
    const result = await deleteBatch(candidates);
    await deleteRunStorage(result.swept, deps);
    if (result.deleted === 0) {
      break;
    }
    deleted += result.deleted;
    batches += 1;
  }

  if (deleted > 0) {
    deps.logger?.info(
      { deleted, batches, keepNewest: policy.keepNewest },
      "Pruned old scheduled Tasks",
    );
  }
  return { deleted, batches };
};
