import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TaskRepo } from "@scarn/core/tasks/task/application/task-repo";
import { syncTaskWithRun } from "@scarn/core/tasks/task/application/on-run-ended";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { Result } from "@scarn/core/lib/result";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  getTaskRunInputSchema,
  type GetTaskRunInput,
  type TaskRunContract,
} from "../contracts/task-run-contracts";
import type { TaskRunRepo } from "./task-run-repo";
import { taskRunEntityToContract } from "./task-run-contract-mapper";

/** Marks a run `running`; its Task becomes `running` too. */
export const markTaskRunRunning = async (
  input: GetTaskRunInput,
  {
    userAuthz,
    taskRunRepo,
    taskRepo,
    timeProvider,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRunRepo: TaskRunRepo;
    taskRepo: TaskRepo;
    timeProvider: TimeProvider;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<TaskRunContract, ResourceNotFoundError>> => {
  const taskRunId = getTaskRunInputSchema.parse(input);
  return await (dbExecutor ?? getDb()).transaction(async (tx) => {
    const task = await taskRunRepo.lock(taskRunId, tx);

    if (!task) {
      return Result.err(new ResourceNotFoundError("Task", taskRunId));
    }

    await userAuthz.requireProjectPermission({
      projectId: task.projectId,
      permission: "executions:write",
    });
    const savedTask = await taskRunRepo.save(
      task.markRunning(timeProvider.now()),
      tx,
    );
    await syncTaskWithRun(
      savedTask,
      { taskRepo, taskRunRepo, timeProvider },
      tx,
    );

    return Result.ok(taskRunEntityToContract(savedTask));
  });
};
