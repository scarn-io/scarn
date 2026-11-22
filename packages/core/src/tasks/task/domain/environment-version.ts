import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";

type PinnedRun = Pick<TaskRunEntity, "number" | "environmentVersionId">;

/**
 * The named environment version a new run of a Task starts pinned to: the
 * `environmentVersionId` of the latest of `runs` that has one, so a run that
 * failed before pinning doesn't unpin the Task. Null when none has.
 */
export const latestEnvironmentVersion = (
  runs: readonly PinnedRun[],
): UuidV7 | null =>
  runs
    .filter((run) => run.environmentVersionId !== null)
    .reduce<PinnedRun | null>(
      (latest, run) =>
        latest === null || run.number > latest.number ? run : latest,
      null,
    )?.environmentVersionId ?? null;
