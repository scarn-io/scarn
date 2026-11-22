import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreError, CoreValidationError } from "@scarn/core/lib/errors";
import type { TaskRunEntity } from "@scarn/core/tasks/task-run/domain/task-run-entity";
import { latestBaseCommit } from "./base-commit";
import { latestEnvironmentVersion } from "./environment-version";
import { TaskEntity } from "./task-entity";
import { FAILED_RUN_STATUSES } from "./retry-decision";

/** Read-time liveness also makes a timed-out or abandoned running Task failed. */
export const taskForRetry = (
  task: TaskEntity,
  latest: TaskRunEntity | null,
  now: Date,
): TaskEntity =>
  task.status === "running" &&
  latest !== null &&
  (latest.status === "timeout" || latest.status === "abandoned")
    ? task.followRun(latest, now)
    : task;

/** Validates a person's retry against the exact attempt they saw. */
export const assertTaskRetryable = (
  task: TaskEntity,
  latest: TaskRunEntity | null,
  expectedLatestRunId: UuidV7 | null,
): void => {
  if ((latest?.id ?? null) !== expectedLatestRunId) {
    throw new CoreError({
      message: "The Task's latest run changed; refresh before retrying",
      code: "TASK_RETRY_STALE_RUN",
      status: 409,
    });
  }
  if (
    (task.status !== "failed" && task.status !== "cancelled") ||
    (latest === null && task.status !== "cancelled") ||
    (latest !== null &&
      !FAILED_RUN_STATUSES.has(latest.status) &&
      latest.status !== "cancelled" &&
      !(task.status === "cancelled" && latest.status === "yielded"))
  ) {
    throw new CoreValidationError(
      "Only a failed or cancelled Task with a failed or cancelled latest run, or a cancelled Task with a yielded latest run, can be retried",
      "TASK_NOT_RETRYABLE",
    );
  }
};

/** Same immutable instructions, first base branch, latest base commit, and no inherited session. */
export const retryTaskAttempt = (
  task: TaskEntity,
  runs: TaskRunEntity[],
  expectedLatestRunId: UuidV7 | null,
  blocked: boolean,
  now: Date,
): { task: TaskEntity; run: TaskRunEntity | null } => {
  const ordered = [...runs].sort((a, b) => a.number - b.number);
  const latest = ordered.at(-1) ?? null;
  const effective = taskForRetry(task, latest, now);
  assertTaskRetryable(effective, latest, expectedLatestRunId);
  const waiting = latest === null && blocked;
  const retried = TaskEntity.rehydrate({
    ...effective.toJSON(),
    status: waiting ? "waiting_for_work" : "queued",
    resultJson: null,
    errorJson: null,
    updatedAt: now,
  });
  return {
    task: retried,
    run: waiting
      ? null
      : retried.newRun({
          number: (latest?.number ?? 0) + 1,
          reason: latest === null ? "initial" : "retry",
          status: "queued",
          baseBranch: ordered[0]?.baseBranch ?? null,
          baseCommit: latestBaseCommit(ordered),
          environmentVersionId: latestEnvironmentVersion(ordered),
          now,
        }),
  };
};
