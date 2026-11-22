import type { z } from "zod";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  CoreValidationError,
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
import {
  withTaskSessionCleanup,
  type EndedTaskSessions,
} from "./delete-task-sessions";
import type { TaskRunEntity } from "../domain/task-run-entity";
import type { NamedError } from "@scarn/core/tasks/task/domain/run-error";
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
 * The hand-over posts the agent's message to the Task's conversation and
 * leaves the Task waiting for a person (`onRunEnded`). It counts as a turn.
 *
 * A yield is a seal: the authority fence (`assertManagedAuthorityForSeal`)
 * runs first, as on completion. When authority moved first, the run fails
 * with `ManagedConnectionAuthorityLost` instead of yielding
 * (`failForAuthorityLoss`); a relayed call in flight or a pending refresh
 * refuses the yield with a 409 for the worker to retry.
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
      const authorityLoss = isTimedOut
        ? null
        : await assertManagedAuthorityForSeal(task, now, deps, tx);
      if (authorityLoss) {
        return Result.ok(
          await failForAuthorityLoss(
            task,
            authorityLoss,
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
        deps,
      });

      return Result.ok(taskRunEntityToContract(saved));
    }),
  );
};

/**
 * A yield the authority fence refused: the run fails with `loss` instead,
 * keeping its branches but not its session, which is never restored and is
 * deleted once the transaction commits. Its log is archived and it ends
 * through `onRunEnded` as a failure, with no hand-over.
 */
const failForAuthorityLoss = async (
  task: TaskRunEntity,
  loss: NamedError,
  input: z.output<typeof yieldClaimedTaskRunInputSchema>,
  now: Date,
  deps: YieldClaimedTaskRunDeps & { endedTaskSessions: EndedTaskSessions },
  tx: DbExecutor,
): Promise<TaskRunContract> => {
  const saved = await deps.taskRunRepo.save(
    task.complete("failed", now, {
      resultJson: null,
      errorJson: loss,
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
