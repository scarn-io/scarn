import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor, DbTransaction } from "@scarn/core/lib/db/db-executor";
import {
  ArtifactExpiredError,
  ResourceNotFoundError,
  type UsageLimitExceededError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { Logger } from "@scarn/observability/logging";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { InMemoryDomainEventDispatcher } from "@scarn/core/lib/domain-events/in-memory-domain-event-dispatcher";
import type { ObjectStore } from "@scarn/core/artifacts/object-store";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import type { OrganizationEntity } from "@scarn/core/organizations/organization/domain/organization-entity";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UsageMeterRepo } from "@scarn/core/billing/usage-meter/application/usage-meter-repo";
import { ensureUsageAllowed } from "@scarn/core/billing/usage-meter/application/ensure-usage-allowed";
import { LogArchiveRetrievedDomainEvent } from "@scarn/core/tasks/task-log/domain/log-archive-retrieved.domain-event";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { ArtifactRepo } from "./artifact-repo";
import { getTaskRunInputSchema } from "@scarn/core/tasks/task-run/contracts/task-run-contracts";
import {
  artifactDownloadUrlSchema,
  type ArtifactDownloadUrlContract,
} from "../contracts/task-artifact-contracts";

const PRESIGN_TTL_SECONDS = 300;

/**
 * Best-effort emission of the read-metering event after a successful artifact
 * download-URL mint. We reuse {@link LogArchiveRetrievedDomainEvent} — the only
 * existing READ-side metering event — because its payload
 * (orgId/projectId/taskRunId) matches and its handler records a generic
 * org read. Read accounting must NOT change the HTTP response, so any failure
 * here is logged and swallowed.
 *
 * Reads do not run inside the caller's transaction by default; we open a short
 * transaction here so the usage handler can take its `FOR UPDATE` row lock. We
 * open it on the supplied `dbExecutor` when present (a passed transaction nests
 * as a savepoint) or on a fresh DB client otherwise.
 */
const emitArtifactRetrievedEvent = async (
  artifact: { taskRunId: UuidV7; projectId: UuidV7 },
  deps: {
    org: OrganizationEntity | null;
    domainEventDispatcher?: InMemoryDomainEventDispatcher | undefined;
    logger?: Logger | undefined;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<void> => {
  const { org, domainEventDispatcher } = deps;
  if (!org || !domainEventDispatcher) {
    return;
  }

  const publish = async (tx: DbTransaction): Promise<void> => {
    await domainEventDispatcher.publish(
      [
        new LogArchiveRetrievedDomainEvent({
          orgId: org.id,
          projectId: artifact.projectId,
          taskRunId: artifact.taskRunId,
        }),
      ],
      tx,
    );
  };

  try {
    const db = deps.dbExecutor ?? getDb();
    await db.transaction(async (tx) => {
      await publish(tx);
    });
  } catch (error) {
    deps.logger?.error(
      { taskRunId: artifact.taskRunId, error },
      "Failed to emit artifact-retrieved usage event",
    );
  }
};

/**
 * UI download path: returns a presigned GET URL for a single stored artifact
 * (when the object store supports presigning). Enforces project read
 * permission, guards against IDOR by verifying the artifact belongs to the
 * addressed task, and pre-flights the org's read cap (402) before
 * minting the URL.
 */
export const getArtifactDownloadUrl = async (
  taskIdInput: string,
  artifactIdInput: string,
  {
    userAuthz,
    taskRunRepo: taskRunRepo,
    artifactRepo,
    objectStore,
    timeProvider,
    orgRepo,
    usageMeterRepo,
    domainEventDispatcher,
    logger,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRunRepo: TaskRunRepo;
    artifactRepo: ArtifactRepo;
    objectStore: ObjectStore | null;
    timeProvider: TimeProvider;
    orgRepo?: OrgRepo | undefined;
    usageMeterRepo?: UsageMeterRepo | undefined;
    domainEventDispatcher?: InMemoryDomainEventDispatcher | undefined;
    logger?: Logger | undefined;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<
  Result<
    ArtifactDownloadUrlContract,
    ResourceNotFoundError | ArtifactExpiredError | UsageLimitExceededError
  >
> => {
  const taskRunId = getTaskRunInputSchema.parse(taskIdInput);
  const artifactId = getTaskRunInputSchema.parse(artifactIdInput);

  const task = await taskRunRepo.load(taskRunId, dbExecutor);
  if (!task) {
    return Result.err(new ResourceNotFoundError("Task", taskRunId));
  }

  const grant = await userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "executions:read",
  });

  const artifact = await artifactRepo.findById(artifactId, dbExecutor);
  // Verifying the artifact belongs to the addressed task prevents
  // IDOR: a caller authorized on one task cannot read another's
  // artifact by swapping the id in the path.
  if (!artifact || artifact.taskRunId !== taskRunId) {
    return Result.err(new ResourceNotFoundError("Artifact", artifactId));
  }

  if (!objectStore) {
    return Result.err(new ResourceNotFoundError("Artifact", artifactId));
  }

  // `storeRef`/`objectKey` are nulled out once the artifact ages past
  // `STORAGE_RETENTION_DAYS` (see `clearExpiredArtifacts`). This is distinct
  // from a missing/IDOR'd artifact (the row still exists and is still
  // listable) so it gets its own 410 result rather than reusing the 404 above.
  const { objectKey } = artifact;
  if (artifact.storeRef === null || objectKey === null) {
    return Result.err(new ArtifactExpiredError(artifactId));
  }

  // Pre-flight READ cap enforcement: block (402) before minting a presigned URL
  // when the org is over its read cap. The owning org is resolved here and
  // reused for the post-read usage event, avoiding a double lookup. Skipped
  // entirely for a public-project non-member read (`grant.isPublicNonMemberGrant`)
  // — that traffic must never be able to exhaust or be blocked by the owning
  // org's quota (issue #149).
  const org =
    orgRepo && usageMeterRepo && !grant.isPublicNonMemberGrant
      ? await orgRepo.findByProjectId(task.projectId, dbExecutor)
      : null;
  if (org && usageMeterRepo) {
    const allowed = await ensureUsageAllowed(
      org.id,
      "read",
      {},
      { usageMeterRepo, timeProvider, dbExecutor },
    );
    if (!allowed.ok) {
      return Result.err(allowed.error);
    }
  }

  const url = await objectStore.getPresignedGetUrl(
    objectKey,
    PRESIGN_TTL_SECONDS,
  );

  await emitArtifactRetrievedEvent(
    { taskRunId, projectId: task.projectId },
    { org, domainEventDispatcher, logger, dbExecutor },
  );

  return Result.ok(
    artifactDownloadUrlSchema.parse({
      url,
      sizeBytes: artifact.sizeBytes,
      contentType: artifact.contentType,
      relativeStorePath: artifact.relativeStorePath,
    }),
  );
};
