import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { ArtifactFailureRepo } from "./artifact-failure-repo";
import { getTaskRunInputSchema } from "@scarn/core/tasks/task-run/contracts/task-run-contracts";
import type { ArtifactFailureContract } from "../contracts/task-artifact-failure-contracts";

/**
 * List all upload failures recorded for a task (newest first),
 * after verifying the caller may read the owning project's executions.
 * Returns a {@link ResourceNotFoundError} when the task does not
 * exist.
 */
export const listTaskArtifactFailures = async (
  taskIdInput: string,
  {
    userAuthz,
    taskRunRepo: taskRunRepo,
    artifactFailureRepo,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRunRepo: TaskRunRepo;
    artifactFailureRepo: ArtifactFailureRepo;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<ArtifactFailureContract[], ResourceNotFoundError>> => {
  const taskRunId = getTaskRunInputSchema.parse(taskIdInput);

  const task = await taskRunRepo.load(taskRunId, dbExecutor);
  if (!task) {
    return Result.err(new ResourceNotFoundError("Task", taskRunId));
  }

  await userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "executions:read",
  });

  return Result.ok(await artifactFailureRepo.listByTask(taskRunId, dbExecutor));
};
