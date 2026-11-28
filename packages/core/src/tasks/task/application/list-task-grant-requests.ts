import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { GrantRequestRepo } from "@scarn/core/tasks/grant-request/application/grant-request-repo";
import {
  grantRequestToContract,
  type GrantRequestContract,
} from "@scarn/core/tasks/grant-request/contracts/grant-request-contracts";
import {
  getTaskInputSchema,
  type GetTaskInput,
} from "../contracts/task-contracts";
import type { TaskRepo } from "./task-repo";

/** A Task's grant requests, oldest first. Needs `executions:read`. */
export const listTaskGrantRequests = async (
  input: GetTaskInput,
  {
    userAuthz,
    taskRepo,
    grantRequestRepo,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRepo: TaskRepo;
    grantRequestRepo: Pick<GrantRequestRepo, "listByTaskId">;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<GrantRequestContract[], ResourceNotFoundError>> => {
  const taskId = getTaskInputSchema.parse(input);
  const task = await taskRepo.load(taskId, dbExecutor);
  if (!task) {
    return Result.err(new ResourceNotFoundError("Task", taskId));
  }
  await userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "executions:read",
  });
  const requests = await grantRequestRepo.listByTaskId(task.id, dbExecutor);
  return Result.ok(requests.map(grantRequestToContract));
};
