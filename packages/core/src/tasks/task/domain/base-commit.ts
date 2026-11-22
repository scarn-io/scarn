import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";

type PinnedRun = Pick<TaskRunEntity, "number" | "baseCommit">;

/**
 * The commit a new run of a Task pins to: the `baseCommit` of the latest of
 * `runs` that has one, so a run that failed before pinning doesn't unpin the
 * Task. Null when none has.
 */
export const latestBaseCommit = (runs: readonly PinnedRun[]): string | null =>
  runs
    .filter((run) => run.baseCommit !== null)
    .reduce<PinnedRun | null>(
      (latest, run) =>
        latest === null || run.number > latest.number ? run : latest,
      null,
    )?.baseCommit ?? null;
