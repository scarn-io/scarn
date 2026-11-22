import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  getTaskRunInputSchema,
  type GetTaskRunInput,
  type TaskRunContract,
} from "../contracts/task-run-contracts";
import type { TaskRunRepo } from "./task-run-repo";
import { taskRunEntityToContract } from "./task-run-contract-mapper";

export const getTaskRun = async (
  input: GetTaskRunInput,
  {
    userAuthz,
    taskRunRepo: taskRunRepo,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRunRepo: TaskRunRepo;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<TaskRunContract, ResourceNotFoundError>> => {
  const taskRunId = getTaskRunInputSchema.parse(input);
  // The entity derives its own liveness against the repo's evaluation instant,
  // so a plain load already reports `abandoned`/`timeout` when clocks lapsed.
  const task = await taskRunRepo.load(taskRunId, dbExecutor);

  if (!task) {
    return Result.err(new ResourceNotFoundError("Task", taskRunId));
  }

  await userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "executions:read",
  });
  return Result.ok(taskRunEntityToContract(task));
};
