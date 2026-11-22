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
import { deriveArtifactObjectKey } from "../domain/artifact-object-key";
import { buildArtifactStoreRef } from "../domain/artifact-store-ref";
import {
  createArtifactUploadUrlInputSchema,
  type ArtifactUploadUrlContract,
  type CreateArtifactUploadUrlInput,
} from "../contracts/task-artifact-contracts";
import {
  getTaskRunInputSchema,
  type GetTaskRunInput,
} from "@scarn/core/tasks/task-run/contracts/task-run-contracts";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import { assertClaimOwnership } from "@scarn/core/tasks/task-run/application/task-run-claim-helpers";

/** Presigned upload URL lifetime. Short-lived: the client uploads immediately. */
const UPLOAD_URL_EXPIRES_IN_SECONDS = 900;

export const createArtifactUploadUrl = async (
  taskIdInput: GetTaskRunInput,
  input: CreateArtifactUploadUrlInput,
  {
    userAuthz,
    taskRunRepo: taskRunRepo,
    objectStore,
    objectStorageBucket,
    timeProvider,
    orgRepo,
    usageMeterRepo,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRunRepo: TaskRunRepo;
    objectStore?: ObjectStore | null | undefined;
    objectStorageBucket?: string | null | undefined;
    timeProvider: TimeProvider;
    orgRepo?: OrgRepo | undefined;
    usageMeterRepo?: UsageMeterRepo | undefined;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<
  Result<
    ArtifactUploadUrlContract,
    ResourceNotFoundError | ConfigurationError | UsageLimitExceededError
  >
> => {
  const taskRunId = getTaskRunInputSchema.parse(taskIdInput);
  const parsedInput = createArtifactUploadUrlInputSchema.parse(input);

  // No transaction is needed: minting a presigned URL writes nothing to our
  // own store (the entity derives its own liveness from the repo's evaluation
  // instant), and the usage-cap pre-flight below only reads the org's meter.
  const task = await taskRunRepo.load(taskRunId, dbExecutor);
  if (!task) {
    return Result.err(new ResourceNotFoundError("Task", taskRunId));
  }
  await userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "executions:write",
  });

  assertClaimOwnership(task, parsedInput.claimToken, timeProvider.now());

  // Pre-flight WRITE cap enforcement (parity with the read-side download-URL
  // guard): block (402) before minting a presigned PUT URL when the org is
  // already at/over its write-count cap, or — when the worker supplied
  // `sizeBytes` — its storage-bytes cap. This is a write path (unlike the
  // download-URL read path), so unlike `getArtifactDownloadUrl` there is no
  // anonymous/public-non-member carve-out to consider: `executions:write` is
  // never granted to a non-member, matching the precedent in
  // `record-task-artifact.ts`, which resolves `org` unconditionally.
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
        "Object storage is not configured; cannot mint artifact upload URL",
        "OBJECT_STORAGE_NOT_CONFIGURED",
      ),
    );
  }

  const objectKey = deriveArtifactObjectKey({
    projectId: task.projectId,
    taskRunId: task.id,
    relativeStorePath: parsedInput.relativeStorePath,
  });

  const uploadUrl = await objectStore.getPresignedPutUrl(
    objectKey,
    UPLOAD_URL_EXPIRES_IN_SECONDS,
    parsedInput.contentType,
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
    storeRef: buildArtifactStoreRef(objectStorageBucket, objectKey),
    objectKey,
    expiresInSeconds: UPLOAD_URL_EXPIRES_IN_SECONDS,
  });
};
