import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  listTaskRunsByProjectIdInputSchema,
  type ListTaskRunsByProjectIdInput,
  type TaskRunContract,
} from "../contracts/task-run-contracts";
import type { TaskRunRepo } from "./task-run-repo";
import { taskRunEntityToContract } from "./task-run-contract-mapper";

export const listTaskRunsByProjectId = async (
  input: ListTaskRunsByProjectIdInput,
  {
    userAuthz,
    taskRunRepo: taskRunRepo,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRunRepo: TaskRunRepo;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<TaskRunContract[]> => {
  const projectId = listTaskRunsByProjectIdInputSchema.parse(input);
  await userAuthz.requireProjectPermission({
    projectId,
    permission: "executions:read",
  });
  // Each entity derives its own liveness against the repo's evaluation instant,
  // so the plain list already reports `abandoned`/`timeout` where clocks lapsed.
  const tasks = await taskRunRepo.listByProjectId(projectId, dbExecutor);

  return tasks.map(taskRunEntityToContract);
};
