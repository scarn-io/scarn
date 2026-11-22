import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import { ResourceOwnershipError } from "@scarn/core/lib/errors";
import type { TaskRunEntity } from "../domain/task-run-entity";

export const buildLeaseExpiresAt = (now: Date, leaseDurationSeconds: number) =>
  new Date(now.getTime() + leaseDurationSeconds * 1_000);

export const buildExecutionDeadlineAt = (task: TaskRunEntity, now: Date) => {
  if (task.executionDeadlineAt) {
    return task.executionDeadlineAt;
  }

  if (!task.executionTimeoutSeconds) {
    return null;
  }

  const startedAtMs = (task.startedAt ?? now).getTime();
  return new Date(startedAtMs + task.executionTimeoutSeconds * 1_000);
};

export const buildTimedOutTaskRunError = (
  task: TaskRunEntity,
  now: Date,
): AnyJsonValue => ({
  code: "TASK_TIMED_OUT",
  message: `Task ${task.id} exceeded its execution timeout`,
  executionDeadlineAt:
    task.executionDeadlineAt?.toISOString() ?? now.toISOString(),
});

export const buildAbandonedTaskRunError = (
  task: TaskRunEntity,
  now: Date,
): AnyJsonValue => ({
  code: "TASK_ABANDONED",
  message: `Task ${task.id} stopped heartbeating before it finished`,
  leaseExpiresAt: task.leaseExpiresAt?.toISOString() ?? now.toISOString(),
});

/** The lease a claim or heartbeat grants: the Task's own heartbeat interval wins. */
export const leaseSecondsFor = (
  task: Pick<TaskRunEntity, "heartbeatSeconds">,
  requestedSeconds: number,
): number => task.heartbeatSeconds ?? requestedSeconds;

export const assertClaimOwnership = (
  task: TaskRunEntity,
  claimToken: string,
  now: Date,
) => {
  // `status` is derived: a step whose lease has lapsed reports `abandoned`, so a
  // worker that lost its lease mid-request gets an ownership error here. This is
  // unchanged from the previous read-overlay behaviour (the overlay reconciled
  // the same step to `abandoned` before this check ran) and is correct: the
  // worker no longer owns the claim. The explicit lease-expiry check below
  // remains as a defence for the case where the derived status is still
  // `running` but the lease boundary was crossed after `evaluatedAt`.
  if (task.status !== "running") {
    throw new ResourceOwnershipError(
      "Task",
      task.id,
      `Task ${task.id} is not running`,
    );
  }

  if (!task.claimToken || task.claimToken !== claimToken) {
    throw new ResourceOwnershipError("Task", task.id);
  }

  if (task.leaseExpiresAt && task.leaseExpiresAt.getTime() <= now.getTime()) {
    throw new ResourceOwnershipError(
      "Task",
      task.id,
      `Task ${task.id} claim has expired`,
    );
  }
};
