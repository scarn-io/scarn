import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  CoreError,
  InvariantViolationError,
  ResourceOwnershipError,
} from "@scarn/core/lib/errors";
import type { ProjectPermission } from "@scarn/core/projects/project/domain/project-permission";
import type { TaskRunEntity } from "../domain/task-run-entity";

export type ClaimingUserDeps = {
  /** Builds the actor for the user who claimed the run. */
  createUserAuthorizationService: (actorId: UuidV7) => UserAuthorizationService;
};

/**
 * The ceiling on what a run may do with work items: the user who claimed it
 * must hold `permission` on the run's project now, whatever the step's grants
 * say. Throws the project permission error (403) otherwise, so removing a
 * member's role stops their worker on its next call. Returns that user's
 * actor, to do the work as.
 */
export const requireClaimingUserProjectPermission = async (
  run: Pick<TaskRunEntity, "id" | "projectId" | "claimedByUserId">,
  permission: ProjectPermission,
  deps: ClaimingUserDeps,
  dbExecutor?: DbExecutor,
): Promise<UserAuthorizationService> => {
  if (!run.claimedByUserId) {
    throw new InvariantViolationError(
      `Task run ${run.id} is running with no claiming user`,
      "TASK_RUN_CLAIMED_BY_USER_MISSING",
    );
  }
  const userAuthz = deps.createUserAuthorizationService(run.claimedByUserId);
  try {
    await userAuthz.requireProjectPermission({
      projectId: run.projectId,
      permission,
      dbExecutor,
    });
  } catch (error) {
    if (error instanceof CoreError && error.code === "PROJECT_FORBIDDEN") {
      throw new CoreError({
        code: "PROJECT_FORBIDDEN",
        message: `The user who claimed task run ${run.id} doesn't have the ${permission} permission on its project, so its work item grants can't be used`,
        status: 403,
        meta: { permission },
      });
    }
    throw error;
  }
  return userAuthz;
};

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
