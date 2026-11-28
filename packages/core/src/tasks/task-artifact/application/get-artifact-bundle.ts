import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import { getTaskRunInputSchema } from "@scarn/core/tasks/task-run/contracts/task-run-contracts";
import type { ArtifactBundleContract } from "../contracts/task-artifact-contracts";
import type { ArtifactBundleRepo } from "./artifact-bundle-repo";
import { toArtifactBundleContract } from "./artifact-bundle-contract";

/**
 * Load one of a task run's artifact bundles, after verifying the caller may
 * read the owning project's executions. A bundle belonging to another task
 * run is reported as not found.
 */
export const getArtifactBundle = async (
  taskIdInput: string,
  bundleIdInput: string,
  {
    userAuthz,
    taskRunRepo,
    artifactBundleRepo,
    timeProvider,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRunRepo: TaskRunRepo;
    artifactBundleRepo: ArtifactBundleRepo;
    timeProvider: TimeProvider;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<ArtifactBundleContract, ResourceNotFoundError>> => {
  const taskRunId = getTaskRunInputSchema.parse(taskIdInput);
  const bundleId = uuidV7Schema.parse(bundleIdInput);

  const task = await taskRunRepo.load(taskRunId, dbExecutor);
  if (!task) {
    return Result.err(new ResourceNotFoundError("Task", taskRunId));
  }

  await userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "executions:read",
  });

  const bundle = await artifactBundleRepo.findById(bundleId, dbExecutor);
  if (!bundle || bundle.taskRunId !== taskRunId) {
    return Result.err(new ResourceNotFoundError("Artifact bundle", bundleId));
  }
  return Result.ok(toArtifactBundleContract(bundle, timeProvider.now()));
};
