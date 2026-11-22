import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  ConfigurationError,
  ResourceNotFoundError,
  type UsageLimitExceededError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { ObjectStore } from "@scarn/core/artifacts/object-store";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import type { UsageMeterRepo } from "@scarn/core/billing/usage-meter/application/usage-meter-repo";
import { ensureUsageAllowed } from "@scarn/core/billing/usage-meter/application/ensure-usage-allowed";
import {
  createSessionUploadUrlInputSchema,
  getTaskRunInputSchema,
  type CreateSessionUploadUrlInput,
  type GetTaskRunInput,
  type SessionUploadUrlContract,
} from "../contracts/task-run-contracts";
import {
  TASK_RUN_SESSION_CONTENT_TYPE,
  taskRunSessionObjectKey,
} from "../domain/task-run-session-object-key";
import { assertClaimOwnership } from "./task-run-claim-helpers";
import type { TaskRunRepo } from "./task-run-repo";

const UPLOAD_URL_EXPIRES_IN_SECONDS = 900;

/**
 * Mints a presigned PUT URL the worker uploads a Task's exported agent
 * session to, before it yields. Works like `createArtifactUploadUrl`: the
 * caller must hold the Task's claim, and the org's write quota is checked
 * first. The key is derived from the Task id; the yield records it.
 */
export const createSessionUploadUrl = async (
  taskIdInput: GetTaskRunInput,
  input: CreateSessionUploadUrlInput,
  {
    userAuthz,
    taskRunRepo,
    objectStore,
    timeProvider,
    orgRepo,
    usageMeterRepo,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRunRepo: TaskRunRepo;
    objectStore?: ObjectStore | null | undefined;
    timeProvider: TimeProvider;
    orgRepo?: OrgRepo | undefined;
    usageMeterRepo?: UsageMeterRepo | undefined;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<
  Result<
    SessionUploadUrlContract,
    ResourceNotFoundError | ConfigurationError | UsageLimitExceededError
  >
> => {
  const taskRunId = getTaskRunInputSchema.parse(taskIdInput);
  const parsedInput = createSessionUploadUrlInputSchema.parse(input);

  const task = await taskRunRepo.load(taskRunId, dbExecutor);
  if (!task) {
    return Result.err(new ResourceNotFoundError("Task", taskRunId));
  }
  await userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "executions:write",
  });
  assertClaimOwnership(task, parsedInput.claimToken, timeProvider.now());

  if (orgRepo && usageMeterRepo) {
    const org = await orgRepo.findByProjectId(task.projectId, dbExecutor);
    if (org) {
      const allowed = await ensureUsageAllowed(
        org.id,
        "write",
        { addBytes: parsedInput.sizeBytes },
        { usageMeterRepo, timeProvider, dbExecutor },
      );
      if (!allowed.ok) {
        return Result.err(allowed.error);
      }
    }
  }

  if (!objectStore) {
    return Result.err(
      new ConfigurationError(
        "Object storage is not configured; cannot mint session upload URL",
        "OBJECT_STORAGE_NOT_CONFIGURED",
      ),
    );
  }

  const objectKey = taskRunSessionObjectKey(task.id);
  const uploadUrl = await objectStore.getPresignedPutUrl(
    objectKey,
    UPLOAD_URL_EXPIRES_IN_SECONDS,
    TASK_RUN_SESSION_CONTENT_TYPE,
  );
  if (uploadUrl === null) {
    return Result.err(
      new ConfigurationError(
        "Object storage cannot mint presigned upload URLs",
        "OBJECT_STORAGE_PRESIGN_UNSUPPORTED",
      ),
    );
  }

  return Result.ok({
    uploadUrl,
    objectKey,
    expiresInSeconds: UPLOAD_URL_EXPIRES_IN_SECONDS,
  });
};
