import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import { taskRunEntityToContract } from "@scarn/core/tasks/task-run/application/task-run-contract-mapper";
import type { TaskRunContract } from "@scarn/core/tasks/task-run/contracts/task-run-contracts";
import {
  getTaskInputSchema,
  type GetTaskInput,
} from "../contracts/task-contracts";
import type { TaskRepo } from "./task-repo";

/** A Task's runs, oldest first. */
export const listTaskRuns = async (
  input: GetTaskInput,
  {
    userAuthz,
    taskRepo,
    taskRunRepo,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRepo: TaskRepo;
    taskRunRepo: TaskRunRepo;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<TaskRunContract[], ResourceNotFoundError>> => {
  const taskId = getTaskInputSchema.parse(input);
  const task = await taskRepo.load(taskId, dbExecutor);
  if (!task) {
    return Result.err(new ResourceNotFoundError("Task", taskId));
  }

  await userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "executions:read",
  });
  const runs = await taskRunRepo.listByTaskId(task.id, dbExecutor);
  return Result.ok(runs.map(taskRunEntityToContract));
};
