import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor, DbTransaction } from "@scarn/core/lib/db/db-executor";
import {
  CoreValidationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { Logger } from "@scarn/observability/logging";
import { AnalyticsEvents } from "@scarn/observability/analytics/events";
import type { AnalyticsPort } from "@scarn/core/lib/analytics/analytics-port";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { InMemoryDomainEventDispatcher } from "@scarn/core/lib/domain-events/in-memory-domain-event-dispatcher";
import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { deriveArtifactObjectKey } from "../domain/artifact-object-key";
import { buildArtifactStoreRef } from "../domain/artifact-store-ref";
import { ArtifactStoredDomainEvent } from "../domain/artifact-stored.domain-event";
import {
  recordArtifactInputSchema,
  type ArtifactContract,
  type RecordArtifactInput,
} from "../contracts/task-artifact-contracts";
import {
  getTaskRunInputSchema,
  type GetTaskRunInput,
} from "@scarn/core/tasks/task-run/contracts/task-run-contracts";
import type { ArtifactRepo } from "./artifact-repo";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import { assertClaimOwnership } from "@scarn/core/tasks/task-run/application/task-run-claim-helpers";

export const recordTaskArtifact = async (
  taskIdInput: GetTaskRunInput,
  input: RecordArtifactInput,
  {
    userAuthz,
    taskRunRepo: taskRunRepo,
    artifactRepo,
    objectStorageBucket,
    orgRepo,
    timeProvider,
    domainEventDispatcher,
    analytics,
    logger,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRunRepo: TaskRunRepo;
    artifactRepo: ArtifactRepo;
    objectStorageBucket?: string | null | undefined;
    orgRepo?: OrgRepo | undefined;
    timeProvider: TimeProvider;
    domainEventDispatcher?: InMemoryDomainEventDispatcher | undefined;
    analytics: AnalyticsPort;
    logger?: Logger | undefined;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<
  Result<ArtifactContract, ResourceNotFoundError | CoreValidationError>
> => {
  const taskRunId = getTaskRunInputSchema.parse(taskIdInput);
  const parsedInput = recordArtifactInputSchema.parse(input);
  const db = dbExecutor ?? getDb();

  const outcome = await db.transaction(async (tx) => {
    const task = await taskRunRepo.load(taskRunId, tx);
    if (!task) {
      return Result.err(new ResourceNotFoundError("Task", taskRunId));
    }
    await userAuthz.requireProjectPermission({
      projectId: task.projectId,
      permission: "executions:write",
    });

    assertClaimOwnership(task, parsedInput.claimToken, timeProvider.now());

    // Anti-spoof: re-derive the key the server would have minted and require the
    // client-reported key to match exactly. This also validates the relative
    // path (rejecting traversal / absolute / backslash paths).
    const expectedObjectKey = deriveArtifactObjectKey({
      projectId: task.projectId,
      taskRunId: task.id,
      relativeStorePath: parsedInput.relativeStorePath,
    });
    if (parsedInput.objectKey !== expectedObjectKey) {
      return Result.err(
        new CoreValidationError(
          "objectKey does not match the derived artifact key",
          "ARTIFACT_OBJECT_KEY_MISMATCH",
        ),
      );
    }

    const artifactId = createUuidV7();
    const artifact = await artifactRepo.record(
      {
        id: artifactId,
        taskRunId: task.id,
        projectId: task.projectId,
        relativeStorePath: parsedInput.relativeStorePath,
        objectKey: expectedObjectKey,
        storeRef: buildArtifactStoreRef(objectStorageBucket, expectedObjectKey),
        sizeBytes: parsedInput.sizeBytes,
        contentType: parsedInput.contentType ?? null,
        kind: parsedInput.kind ?? "generic",
      },
      tx,
    );

    await emitArtifactStoredEvent(
      {
        projectId: task.projectId,
        taskRunId: task.id,
        artifactId,
        // Pass the just-validated input value rather than round-tripping
        // through `artifact.sizeBytes`: the shared `ArtifactContract` type now
        // says `sizeBytes: number | null` (nulled once an artifact expires,
        // see Phase 2), but at this call site the row was just inserted with
        // `parsedInput.sizeBytes` (validated non-negative int), so it is
        // always non-null here — using the input value directly avoids a
        // null-assertion on a freshly-inserted row.
        sizeBytes: parsedInput.sizeBytes,
      },
      { orgRepo, domainEventDispatcher, logger, dbExecutor: tx },
    );

    return Result.ok(artifact);
  });

  if (outcome.ok) {
    analytics.capture(userAuthz.actorId, AnalyticsEvents.ArtifactProduced, {
      project_id: outcome.value.projectId,
      task_id: outcome.value.taskRunId,
      artifact_id: outcome.value.id,
      kind: outcome.value.kind,
    });
  }
  return outcome;
};

/**
 * Best-effort emission of {@link ArtifactStoredDomainEvent} for usage metering,
 * mirroring the log-archived event path in `finalize-task-log`. The
 * owning org is resolved here and the event is published within the active
 * transaction so the usage handler's `FOR UPDATE` lock participates in the same
 * atomic unit. Any failure is logged and swallowed so usage accounting can never
 * break artifact recording. Only emitted when `orgRepo` + `domainEventDispatcher`
 * are wired.
 */
const emitArtifactStoredEvent = async (
  artifact: {
    projectId: UuidV7;
    taskRunId: UuidV7;
    artifactId: UuidV7;
    sizeBytes: number;
  },
  {
    orgRepo,
    domainEventDispatcher,
    logger,
    dbExecutor,
  }: {
    orgRepo?: OrgRepo | undefined;
    domainEventDispatcher?: InMemoryDomainEventDispatcher | undefined;
    logger?: Logger | undefined;
    dbExecutor: DbTransaction;
  },
): Promise<void> => {
  if (!orgRepo || !domainEventDispatcher) {
    return;
  }

  try {
    const org = await orgRepo.findByProjectId(artifact.projectId, dbExecutor);
    if (!org) {
      return;
    }

    await dbExecutor.transaction(async (tx) => {
      await domainEventDispatcher.publish(
        [
          new ArtifactStoredDomainEvent({
            orgId: org.id,
            projectId: artifact.projectId,
            taskRunId: artifact.taskRunId,
            artifactId: artifact.artifactId,
            sizeBytes: artifact.sizeBytes,
          }),
        ],
        tx,
      );
    });
  } catch (error) {
    logger?.error(
      { taskRunId: artifact.taskRunId, error },
      "Failed to emit artifact-stored usage event",
    );
  }
};
