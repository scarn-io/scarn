import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreError, InvariantViolationError } from "@scarn/core/lib/errors";
import {
  applyWorkItemChanges,
  type ApplyWorkItemChangesDeps,
} from "@scarn/core/tasks/task/application/apply-work-item-changes";
import { WORK_ITEM_CHANGE_NOT_NATIVE } from "@scarn/core/tasks/task/application/validate-work-item-changes";
import {
  MAX_WORK_ITEM_CHANGES,
  type WorkItemChange,
} from "@scarn/core/tasks/task/contracts/work-item-change-contracts";
import {
  TASK_ERROR_NAMES,
  type NamedError,
} from "@scarn/core/tasks/task/domain/run-error";
import type { TaskRunEntity } from "../domain/task-run-entity";
import {
  requireClaimingUserProjectPermission,
  type ClaimingUserDeps,
} from "./task-run-claim-helpers";

export type SettleWorkItemChangesDeps = ApplyWorkItemChangesDeps &
  ClaimingUserDeps;

/**
 * Runs `check`, a check or application of work item changes. Returns null
 * when it passed, or the named error a run fails with when it refused them:
 * `Scarn.WorkItemNotNative` or `Scarn.WorkItemChangesInvalid`. Errors that
 * aren't a refusal (a database failure) throw.
 */
export const workItemChangesRefusal = async (
  check: () => Promise<void>,
): Promise<NamedError | null> => {
  try {
    await check();
    return null;
  } catch (error) {
    if (!(error instanceof CoreError) || error.status >= 500) {
      throw error;
    }
    return {
      name:
        error.code === WORK_ITEM_CHANGE_NOT_NATIVE
          ? TASK_ERROR_NAMES.workItemNotNative
          : TASK_ERROR_NAMES.workItemChangesInvalid,
      message: error.message,
    };
  }
};

/** The refusal of a Task holding more than `MAX_WORK_ITEM_CHANGES` changes. */
export const tooManyWorkItemChanges = (count: number): NamedError => ({
  name: TASK_ERROR_NAMES.workItemChangesInvalid,
  message: `The Task would hold ${String(count)} work item changes; at most ${String(MAX_WORK_ITEM_CHANGES)} apply`,
});

/**
 * Applies a succeeded run's work item changes in `tx`, once its log is kept,
 * as the user who claimed the run: the ones its Task held from earlier
 * hand-overs, then `changes`, and the Task stops holding them. Returns null
 * when they applied, or the named error the run fails with instead:
 * `Scarn.LogArchiveFailed` when the archive wasn't written,
 * `Scarn.WorkItemChangesInvalid` when there are more than
 * `MAX_WORK_ITEM_CHANGES`, or the refusal of a change
 * (`workItemChangesRefusal`). The changes apply in a savepoint, so a refused
 * one leaves nothing behind.
 *
 * The claiming user must still hold `work-items:write`: the step's grants
 * only narrow what that user may do. A user who lost it since the claim
 * fails the run with `Scarn.WorkItemChangesInvalid` rather than having the
 * changes dropped while the run reports success.
 */
export const settleWorkItemChanges = async (
  run: TaskRunEntity,
  changes: WorkItemChange[],
  logKept: () => Promise<boolean>,
  deps: SettleWorkItemChangesDeps,
  tx: DbExecutor,
): Promise<NamedError | null> => {
  if (!(await logKept())) {
    return {
      name: TASK_ERROR_NAMES.logArchiveFailed,
      message:
        "The run's log archive wasn't written, so its work item changes weren't applied",
    };
  }

  const task = await deps.taskRepo.lock(run.taskId, tx);
  if (!task) {
    throw new InvariantViolationError(
      `Task ${run.taskId} of run ${run.id} is missing`,
      "TASK_MISSING",
    );
  }
  const settled = [...task.heldWorkItemChanges, ...changes];
  if (settled.length > MAX_WORK_ITEM_CHANGES) {
    return tooManyWorkItemChanges(settled.length);
  }

  const refusal = await workItemChangesRefusal(async () => {
    const userAuthz = await requireClaimingUserProjectPermission(
      run,
      "work-items:write",
      deps,
      tx,
    );
    await tx.transaction(async (savepoint) => {
      await applyWorkItemChanges(
        task,
        settled,
        { ...deps, userAuthz },
        savepoint,
      );
    });
  });
  if (refusal) {
    return refusal;
  }
  await deps.taskRepo.save(
    task.clearHeldWorkItemChanges(deps.timeProvider.now()),
    tx,
  );
  return null;
};
