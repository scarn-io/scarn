import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  getTaskRunInputSchema,
  taskRunClaimCommandInputSchema,
  type GetTaskRunInput,
  type TaskRunClaimCommandInput,
  type TaskRunContract,
  type TaskRunHeartbeatContract,
} from "../contracts/task-run-contracts";
import type { TaskRunRepo } from "./task-run-repo";
import { taskRunEntityToContract } from "./task-run-contract-mapper";
import { assertClaimOwnership } from "./task-run-claim-helpers";
import type { TerminalTaskRunHandlers } from "./fail-terminal-task-runs";
import { checkManagedAuthorityForHeartbeat } from "@scarn/core/connections/managed-mcp-connection/application/check-managed-authority-for-heartbeat";
import type { ReadManagedAuthorityChecksDeps } from "@scarn/core/connections/managed-mcp-connection/application/read-managed-authority-checks";

const withManagedAuthorityOk = <E>(
  result: Result<TaskRunContract, E>,
): Result<TaskRunHeartbeatContract, E> =>
  result.ok
    ? Result.ok({ ...result.value, managedAuthority: "ok" as const })
    : result;

/**
 * Extends the claim a worker holds on a Task. A Task past its execution
 * deadline is failed as `timeout` instead, through `terminalTaskHandlers`
 * so the pipeline side can advance its run.
 *
 * Workers heartbeat often, so the common case is one statement: it extends
 * the lease only if the claim still holds and the caller's membership grants
 * `executions:write`. Anything else (wrong token, lapsed lease or deadline,
 * missing run, non-member actor) falls through to the full checks, which
 * decide the outcome and the error.
 *
 * The response carries `managedAuthority`: whether the managed connections
 * the run's launch pinned still authorize it (decision 3), so the worker
 * aborts an idle run promptly. A run without managed launches costs one
 * extra query.
 */
export const heartbeatTaskRunClaim = async (
  taskIdInput: GetTaskRunInput,
  input: TaskRunClaimCommandInput,
  {
    userAuthz,
    taskRunRepo,
    timeProvider,
    terminalTaskHandlers: handlers,
    dbExecutor,
    ...managedDeps
  }: ReadManagedAuthorityChecksDeps & {
    userAuthz: UserAuthorizationService;
    taskRunRepo: TaskRunRepo;
    timeProvider: TimeProvider;
    terminalTaskHandlers: TerminalTaskRunHandlers;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<TaskRunHeartbeatContract, ResourceNotFoundError>> => {
  const taskRunId = getTaskRunInputSchema.parse(taskIdInput);
  const parsedInput = taskRunClaimCommandInputSchema.parse(input);
  const db = dbExecutor ?? getDb();

  const extended = await taskRunRepo.heartbeat(
    taskRunId,
    parsedInput.claimToken,
    {
      now: timeProvider.now(),
      leaseDurationSeconds: parsedInput.leaseDurationSeconds,
      member: { userId: userAuthz.actorId, permission: "executions:write" },
    },
    db,
  );
  if (extended) {
    const managedAuthority = await checkManagedAuthorityForHeartbeat(
      extended,
      timeProvider.now(),
      managedDeps,
      db,
    );
    return Result.ok({
      ...taskRunEntityToContract(extended),
      managedAuthority,
    });
  }

  return await db.transaction(async (tx) => {
    const task = await taskRunRepo.load(taskRunId, tx);
    if (!task) {
      return Result.err(new ResourceNotFoundError("Task", taskRunId));
    }
    await userAuthz.requireProjectPermission({
      projectId: task.projectId,
      permission: "executions:write",
    });

    if (task.status === "timeout") {
      return withManagedAuthorityOk(
        task.hasOutcome()
          ? Result.ok(taskRunEntityToContract(task))
          : await handlers.failTimedOut(task.id, tx),
      );
    }

    const now = timeProvider.now();
    assertClaimOwnership(task, parsedInput.claimToken, now);

    if (
      task.executionDeadlineAt &&
      task.executionDeadlineAt.getTime() <= now.getTime()
    ) {
      return withManagedAuthorityOk(await handlers.failTimedOut(task.id, tx));
    }

    const updated = await taskRunRepo.heartbeat(
      task.id,
      parsedInput.claimToken,
      { now, leaseDurationSeconds: parsedInput.leaseDurationSeconds },
      tx,
    );

    if (!updated) {
      return Result.err(new ResourceNotFoundError("Task", task.id));
    }

    const managedAuthority = await checkManagedAuthorityForHeartbeat(
      updated,
      now,
      managedDeps,
      tx,
    );
    return Result.ok({ ...taskRunEntityToContract(updated), managedAuthority });
  });
};
