import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor, DbTransaction } from "@scarn/core/lib/db/db-executor";
import {
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
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import { LogArchiveRetrievedDomainEvent } from "../domain/log-archive-retrieved.domain-event";
import {
  taskIdInputSchema,
  type TaskLogArchiveContract,
} from "../contracts/task-log-contracts";

const PRESIGN_TTL_SECONDS = 300;

/**
 * Best-effort emission of {@link LogArchiveRetrievedDomainEvent} after a
 * successful read. Publishes the event (for the org already resolved by the
 * caller's read guard) so billing handlers can account the read (Phase 4). Read
 * accounting must NOT change the HTTP response, so any failure here is logged
 * and swallowed.
 *
 * Reads do not run inside the caller's transaction by default; we open a short
 * transaction here so the usage handler can take its `FOR UPDATE` row lock. We
 * open it on the supplied `dbExecutor` when present (a passed transaction nests
 * as a savepoint) or on a fresh DB client otherwise.
 */
const emitLogArchiveRetrievedEvent = async (
  archive: { taskRunId: UuidV7; projectId: UuidV7 },
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
          projectId: archive.projectId,
          taskRunId: archive.taskRunId,
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
      { taskRunId: archive.taskRunId, error },
      "Failed to emit log-retrieved usage event",
    );
  }
};

/**
 * UI archive path: returns a presigned URL for the finalized NDJSON log object
 * (when the object store supports presigning) or signals the caller to proxy
 * the bytes via {@link ObjectStore.getObject}.
 */
export const getTaskLogArchive = async (
  taskIdInput: string,
  {
    userAuthz,
    taskRunRepo,
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
    TaskLogArchiveContract,
    ResourceNotFoundError | UsageLimitExceededError
  >
> => {
  const taskRunId = taskIdInputSchema.parse(taskIdInput);

  const task = await taskRunRepo.load(taskRunId, dbExecutor);
  if (!task) {
    return Result.err(new ResourceNotFoundError("Task", taskRunId));
  }

  const grant = await userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "executions:read",
  });

  const archive = await taskRunRepo.getLogArchive(taskRunId, dbExecutor);
  if (!archive || !objectStore) {
    return Result.err(new ResourceNotFoundError("Task log archive", taskRunId));
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
    archive.storeRef,
    PRESIGN_TTL_SECONDS,
  );

  await emitLogArchiveRetrievedEvent(
    { taskRunId, projectId: task.projectId },
    { org, domainEventDispatcher, logger, dbExecutor },
  );

  return Result.ok({ url, sizeBytes: archive.sizeBytes });
};

/**
 * Read the raw archive bytes for proxying through the API (used when the object
 * store cannot presign). Returns null when no archive exists.
 */
export const readTaskLogArchiveBytes = async (
  taskIdInput: string,
  {
    userAuthz,
    taskRunRepo,
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
    objectStore: ObjectStore | null;
    timeProvider: TimeProvider;
    orgRepo?: OrgRepo | undefined;
    usageMeterRepo?: UsageMeterRepo | undefined;
    domainEventDispatcher?: InMemoryDomainEventDispatcher | undefined;
    logger?: Logger | undefined;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<
  Result<Uint8Array, ResourceNotFoundError | UsageLimitExceededError>
> => {
  const taskRunId = taskIdInputSchema.parse(taskIdInput);

  const task = await taskRunRepo.load(taskRunId, dbExecutor);
  if (!task) {
    return Result.err(new ResourceNotFoundError("Task", taskRunId));
  }

  const grant = await userAuthz.requireProjectPermission({
    projectId: task.projectId,
    permission: "executions:read",
  });

  const archive = await taskRunRepo.getLogArchive(taskRunId, dbExecutor);
  if (!archive || !objectStore) {
    return Result.err(new ResourceNotFoundError("Task log archive", taskRunId));
  }

  // Pre-flight READ cap enforcement: block (402) before reading bytes when the
  // org is over its read cap. Owning org resolved once and reused for the
  // event. Skipped entirely for a public-project non-member read (see the
  // sibling `getTaskLogArchive` above for the full rationale).
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

  const object = await objectStore.getObject(archive.storeRef);
  if (!object) {
    return Result.err(new ResourceNotFoundError("Task log archive", taskRunId));
  }

  await emitLogArchiveRetrievedEvent(
    { taskRunId, projectId: task.projectId },
    { org, domainEventDispatcher, logger, dbExecutor },
  );

  return Result.ok(object.body);
};
