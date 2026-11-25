import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreValidationError, ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { ProjectPermission } from "@scarn/core/projects/project/domain/project-permission";
import type { TaskRepo } from "@scarn/core/tasks/task/application/task-repo";
import type { TaskEntity } from "@scarn/core/tasks/task/domain/task-entity";
import type { TaskRunEntity } from "../domain/task-run-entity";
import {
  assertClaimOwnership,
  requireClaimingUserProjectPermission,
  type ClaimingUserDeps,
} from "./task-run-claim-helpers";
import type { TaskRunRepo } from "./task-run-repo";

/** A code step's work-item call its step's grants don't cover. */
export const WORK_ITEM_GRANT_MISSING = "WORK_ITEM_GRANT_MISSING";

export const grantMissing = (
  message: string,
  meta?: Record<string, unknown>,
): CoreValidationError =>
  new CoreValidationError(message, WORK_ITEM_GRANT_MISSING, meta);

export type CodeStepWorkItemAccessDeps = ClaimingUserDeps & {
  taskRunRepo: Pick<TaskRunRepo, "load">;
  taskRepo: Pick<TaskRepo, "load">;
  timeProvider: TimeProvider;
};

export type CodeStepWorkItemAccess = {
  run: TaskRunEntity;
  task: TaskEntity;
  userAuthz: UserAuthorizationService;
};

/**
 * The checks every code-step work-item call starts with: the run is live
 * under `claimToken`, it is a `code` step's run, and the user who claimed it
 * holds `permission` on its project now. Returns the run, its Task and the
 * claiming user's actor to do the work as.
 */
export const requireCodeStepWorkItemAccess = async (
  taskRunId: TaskRunEntity["id"],
  claimToken: string,
  permission: ProjectPermission,
  deps: CodeStepWorkItemAccessDeps,
  tx: DbExecutor,
): Promise<Result<CodeStepWorkItemAccess, ResourceNotFoundError>> => {
  const run = await deps.taskRunRepo.load(taskRunId, tx);
  if (!run) {
    return Result.err(new ResourceNotFoundError("Task", taskRunId));
  }
  assertClaimOwnership(run, claimToken, deps.timeProvider.now());
  const userAuthz = await requireClaimingUserProjectPermission(
    run,
    permission,
    deps,
    tx,
  );
  const task = await deps.taskRepo.load(run.taskId, tx);
  if (!task || task.projectId !== run.projectId) {
    return Result.err(new ResourceNotFoundError("Task", run.taskId));
  }
  if (task.kind !== "code") {
    throw grantMissing(
      `Only a code step's run may use this; task run ${run.id} is a '${task.kind}' step's`,
    );
  }
  return Result.ok({ run, task, userAuthz });
};
