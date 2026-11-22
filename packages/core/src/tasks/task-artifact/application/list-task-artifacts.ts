import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { ArtifactRepo } from "./artifact-repo";
import { getTaskRunInputSchema } from "@scarn/core/tasks/task-run/contracts/task-run-contracts";
import type { ArtifactContract } from "../contracts/task-artifact-contracts";

/**
 * List all artifacts recorded for a task (newest first), after
 * verifying the caller may read the owning project's executions. Returns a
 * {@link ResourceNotFoundError} when the task does not exist.
 */
export const listTaskArtifacts = async (
  taskIdInput: string,
  {
    userAuthz,
    taskRunRepo: taskRunRepo,
    artifactRepo,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRunRepo: TaskRunRepo;
    artifactRepo: ArtifactRepo;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<ArtifactContract[], ResourceNotFoundError>> => {
  const taskRunId = getTaskRunInputSchema.parse(taskIdInput);

  const task = await taskRunRepo.load(taskRunId, dbExecutor);
  if (!task) {
    return Result.err(new ResourceNotFoundError("Task", taskRunId));
  }

  await userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "executions:read",
  });

  return Result.ok(await artifactRepo.listByTask(taskRunId, dbExecutor));
};
