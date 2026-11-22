import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { WorkNotifier } from "@scarn/core/tasks/task-run/application/work-notifier";
import type { TaskRunReason } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type { WorkItemBlockRepo } from "@scarn/core/work-items/work-item-block/application/work-item-block-repo";
import { latestBaseCommit } from "../domain/base-commit";
import { latestEnvironmentVersion } from "../domain/environment-version";
import type { TaskEntity } from "../domain/task-entity";
import type { TaskRepo } from "./task-repo";

export type StartReadyWorkDeps = {
  taskRepo: TaskRepo;
  taskRunRepo: TaskRunRepo;
  workItemBlockRepo: WorkItemBlockRepo;
  timeProvider: TimeProvider;
  workNotifier: WorkNotifier;
};

/**
 * A fresh waiting Task gets its `initial` run; one that already has runs
 * waited after a run of its own, so it continues.
 */
const nextRunReason = (runCount: number): TaskRunReason =>
  runCount === 0 ? "initial" : "continuation";

const queueNextRun = async (
  task: TaskEntity,
  deps: StartReadyWorkDeps,
  tx: DbExecutor,
): Promise<void> => {
  const runs = await deps.taskRunRepo.listByTaskId(task.id, tx);
  const now = deps.timeProvider.now();
  const run = await deps.taskRunRepo.create(
    task.newRun({
      number: Math.max(0, ...runs.map((each) => each.number)) + 1,
      reason: nextRunReason(runs.length),
      status: "queued",
      baseBranch: runs[0]?.baseBranch ?? null,
      baseCommit: latestBaseCommit(runs),
      environmentVersionId: latestEnvironmentVersion(runs),
      now,
    }),
    tx,
  );
  deps.workNotifier.enqueued(run.projectId);
  await deps.taskRepo.save(task.followRun(run, now), tx);
};

/**
 * Given work items whose readiness may have changed, queues the next run of
 * every `waiting_for_work` Task on each one that is now ready (no open
 * blockers). Runs in the transaction of the change that caused it, behind
 * `WorkItemEventsPort`.
 */
export const startReadyWork = async (
  workItemIds: UuidV7[],
  deps: StartReadyWorkDeps,
  tx: DbExecutor,
): Promise<void> => {
  const uniqueIds = [...new Set(workItemIds)];
  if (uniqueIds.length === 0) {
    return;
  }

  const waiting = await deps.taskRepo.lockWaitingForWorkByWorkItemIds(
    uniqueIds,
    tx,
  );
  if (waiting.length === 0) {
    return;
  }

  const blocked = new Set(
    await deps.workItemBlockRepo.listIdsWithOpenBlockers(
      [
        ...new Set(
          waiting.flatMap((task) =>
            task.workItemId === null ? [] : [task.workItemId],
          ),
        ),
      ],
      tx,
    ),
  );
  for (const task of waiting) {
    if (task.workItemId !== null && !blocked.has(task.workItemId)) {
      await queueNextRun(task, deps, tx);
    }
  }
};
