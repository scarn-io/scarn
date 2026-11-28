import type { z } from "zod";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  CoreValidationError,
  InvariantViolationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  getTaskRunInputSchema,
  yieldClaimedTaskRunInputSchema,
  type GetTaskRunInput,
  type TaskRunContract,
  type YieldClaimedTaskRunInput,
} from "../contracts/task-run-contracts";
import { taskRunSessionObjectKey } from "../domain/task-run-session-object-key";
import { taskRunEntityToContract } from "./task-run-contract-mapper";
import {
  assertClaimOwnership,
  buildTimedOutTaskRunError,
} from "./task-run-claim-helpers";
import {
  finalizeCompletedStepLog,
  type FinalizeLogDeps,
} from "./complete-claimed-task-run";
import {
  onRunEnded,
  type OnRunEndedDeps,
} from "@scarn/core/tasks/task/application/on-run-ended";
import type { HandOverDeps } from "@scarn/core/tasks/task/application/hand-over";
import { validateWorkItemChanges } from "@scarn/core/tasks/task/application/validate-work-item-changes";
import {
  MAX_WORK_ITEM_CHANGES,
  type WorkItemChange,
} from "@scarn/core/tasks/task/contracts/work-item-change-contracts";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import {
  tooManyWorkItemChanges,
  workItemChangesRefusal,
} from "./settle-work-item-changes";
import {
  withTaskSessionCleanup,
  type EndedTaskSessions,
} from "./delete-task-sessions";
import type { TaskRunEntity } from "../domain/task-run-entity";
import type { NamedError } from "@scarn/core/tasks/task/domain/run-error";
import {
  grantKindRefusals,
  type Grant,
} from "@scarn/core/tasks/task/domain/grants";
import {
  assertManagedAuthorityForSeal,
  type AssertManagedAuthorityForSealDeps,
} from "@scarn/core/connections/managed-mcp-connection/application/assert-managed-authority-for-seal";
import {
  recordSessionSaved,
  releaseTaskRunSessions,
  type TaskRunSessionsDeps,
} from "./task-run-sessions";

export type YieldClaimedTaskRunDeps = FinalizeLogDeps &
  OnRunEndedDeps &
  HandOverDeps &
  TaskRunSessionsDeps &
  AssertManagedAuthorityForSealDeps & {
    userAuthz: UserAuthorizationService;
    workItemRepo: Pick<WorkItemRepo, "loadMany">;
    dbExecutor?: DbExecutor | undefined;
  };

/**
 * Records that the agent of a Task the worker holds the claim on ended its
 * turn with a yield: the run ends `yielded` with its work branch and session,
 * and its log is archived so a continuation can read the transcript. A Task
 * past its execution deadline is recorded as `timeout` instead. A Task keeps
 * only its latest run's session: the yield releases its other runs' sessions
 * (`releaseTaskRunSessions`) and meters the one it attached
 * (`recordSessionSaved`).
 * `taskOutcomePort` hears of the Task in the same transaction.
 *
 * The work item changes the agent recorded (`workItemChanges`) are checked
 * against the Task's grants as they are now and held on the Task, to apply
 * when it succeeds (`holdYieldedWorkItemChanges`). A refused change fails the
 * run with the named error settling would, instead of yielding.
 *
 * The hand-over posts the agent's message to the Task's conversation and
 * leaves the Task waiting for a person (`onRunEnded`). It counts as a turn.
 * A `grantRequest` rides along and is recorded by the hand-over; one the
 * Task may not make is refused with a 422 before anything changes
 * (`assertGrantRequestAllowed`).
 *
 * A yield is a seal: the authority fence (`assertManagedAuthorityForSeal`)
 * runs first, as on completion. When authority moved first, the run fails
 * with `ManagedConnectionAuthorityLost` instead of yielding (`failYield`); a
 * relayed call in flight or a pending refresh refuses the yield with a 409
 * for the worker to retry.
 */
export const yieldClaimedTaskRun = async (
  taskIdInput: GetTaskRunInput,
  input: YieldClaimedTaskRunInput,
  deps: YieldClaimedTaskRunDeps,
): Promise<Result<TaskRunContract, ResourceNotFoundError>> => {
  const { userAuthz, taskRunRepo, timeProvider, dbExecutor } = deps;
  const taskRunId = getTaskRunInputSchema.parse(taskIdInput);
  const parsedInput = yieldClaimedTaskRunInputSchema.parse(input);
  const db = dbExecutor ?? getDb();

  return await withTaskSessionCleanup(deps, (endedTaskSessions) =>
    db.transaction(async (tx) => {
      const task = await taskRunRepo.lock(taskRunId, tx);
      if (!task) {
        return Result.err(new ResourceNotFoundError("Task", taskRunId));
      }
      await userAuthz.requireProjectPermission({
        projectId: task.projectId,
        permission: "executions:write",
        dbExecutor: tx,
      });

      const now = timeProvider.now();
      assertClaimOwnership(task, parsedInput.claimToken, now);
      if (
        parsedInput.sessionObjectKey &&
        parsedInput.sessionObjectKey !== taskRunSessionObjectKey(task.id)
      ) {
        throw new CoreValidationError(
          "sessionObjectKey must be the key returned by the session upload URL",
          "TASK_SESSION_OBJECT_KEY_MISMATCH",
        );
      }

      const isTimedOut =
        task.executionDeadlineAt !== null &&
        task.executionDeadlineAt !== undefined &&
        task.executionDeadlineAt.getTime() <= now.getTime();
      if (!isTimedOut && parsedInput.grantRequest) {
        await assertGrantRequestAllowed(
          task,
          parsedInput.grantRequest.grants,
          deps,
          tx,
        );
      }
      const failure = isTimedOut
        ? null
        : ((await assertManagedAuthorityForSeal(task, now, deps, tx)) ??
          (await holdYieldedWorkItemChanges(
            task,
            parsedInput.workItemChanges ?? [],
            now,
            deps,
            tx,
          )));
      if (failure) {
        return Result.ok(
          await failYield(
            task,
            failure,
            parsedInput,
            now,
            { ...deps, endedTaskSessions },
            tx,
          ),
        );
      }
      const yielded = isTimedOut
        ? task.failWith("timeout", buildTimedOutTaskRunError(task, now), now)
        : task.yield(now, {
            message: parsedInput.message,
            sessionObjectKey: parsedInput.sessionObjectKey,
            sessionSizeBytes: parsedInput.sessionSizeBytes,
            workBranch: parsedInput.workBranch,
            createdFromBranch: parsedInput.createdFromBranch,
            sessionRestored: parsedInput.sessionRestored,
          });
      const saved = await taskRunRepo.save(yielded, tx);
      await releaseTaskRunSessions(
        (await taskRunRepo.listByTaskId(saved.taskId, tx)).filter(
          (run) => run.id !== saved.id,
        ),
        { ...deps, endedTaskSessions },
        tx,
      );
      await recordSessionSaved(saved, deps, tx);

      await finalizeCompletedStepLog(saved.id, saved.projectId, deps, tx);
      await onRunEnded(saved, { ...deps, endedTaskSessions }, tx, {
        message: parsedInput.message,
        grantRequest: parsedInput.grantRequest,
        deps,
      });

      return Result.ok(taskRunEntityToContract(saved));
    }),
  );
};

/**
 * Refuses, with a 422 before anything changes, a grant request the Task may
 * not make: its Task doesn't take grant requests, or a grant doesn't fit an
 * agent (`grantKindRefusals`).
 */
const assertGrantRequestAllowed = async (
  run: TaskRunEntity,
  grants: readonly Grant[],
  deps: YieldClaimedTaskRunDeps,
  tx: DbExecutor,
): Promise<void> => {
  const task = await deps.taskRepo.lock(run.taskId, tx);
  if (!task) {
    throw new InvariantViolationError(
      `Task ${run.taskId} of run ${run.id} is missing`,
      "TASK_MISSING",
    );
  }
  if (!task.grantRequests) {
    throw new CoreValidationError(
      `Task ${task.id} may not request grants`,
      "GRANT_REQUEST_NOT_ALLOWED",
    );
  }
  const refusals = grantKindRefusals("agent", grants);
  if (refusals.length > 0) {
    throw new CoreValidationError(
      refusals.join("; "),
      "GRANT_REQUEST_NOT_ALLOWED",
      { refusals },
    );
  }
};

/**
 * Holds `changes` on `run`'s Task after the ones it already holds, once
 * they all pass `validateWorkItemChanges` against its grants as they are now
 * and stay within `MAX_WORK_ITEM_CHANGES`. Returns null when they're held,
 * or the named error the run fails with instead.
 */
const holdYieldedWorkItemChanges = async (
  run: TaskRunEntity,
  changes: WorkItemChange[],
  now: Date,
  deps: YieldClaimedTaskRunDeps,
  tx: DbExecutor,
): Promise<NamedError | null> => {
  if (changes.length === 0) {
    return null;
  }
  const task = await deps.taskRepo.lock(run.taskId, tx);
  if (!task) {
    throw new InvariantViolationError(
      `Task ${run.taskId} of run ${run.id} is missing`,
      "TASK_MISSING",
    );
  }
  const held = [...task.heldWorkItemChanges, ...changes];
  if (held.length > MAX_WORK_ITEM_CHANGES) {
    return tooManyWorkItemChanges(held.length);
  }
  const refusal = await workItemChangesRefusal(() =>
    validateWorkItemChanges(task, held, deps, tx),
  );
  if (refusal) {
    return refusal;
  }
  await deps.taskRepo.save(task.holdWorkItemChanges(changes, now), tx);
  return null;
};

/**
 * A yield refused by the authority fence or its work item changes: the run
 * fails with `failure` instead, keeping its branches but not its session,
 * which is never restored and is deleted once the transaction commits. Its log is archived and it ends
 * through `onRunEnded` as a failure, with no hand-over.
 */
const failYield = async (
  task: TaskRunEntity,
  failure: NamedError,
  input: z.output<typeof yieldClaimedTaskRunInputSchema>,
  now: Date,
  deps: YieldClaimedTaskRunDeps & { endedTaskSessions: EndedTaskSessions },
  tx: DbExecutor,
): Promise<TaskRunContract> => {
  const saved = await deps.taskRunRepo.save(
    task.complete("failed", now, {
      resultJson: null,
      errorJson: failure,
      workBranch: input.workBranch,
      createdFromBranch: input.createdFromBranch,
      sessionRestored: input.sessionRestored,
    }),
    tx,
  );
  if (input.sessionObjectKey) {
    deps.endedTaskSessions.add(input.sessionObjectKey);
  }
  await finalizeCompletedStepLog(saved.id, saved.projectId, deps, tx);
  await onRunEnded(saved, deps, tx);
  return taskRunEntityToContract(saved);
};
