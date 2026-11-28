import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { Logger } from "@scarn/observability/logging";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { InMemoryDomainEventDispatcher } from "@scarn/core/lib/domain-events/in-memory-domain-event-dispatcher";
import type { ObjectStore } from "@scarn/core/artifacts/object-store";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import {
  uuidV7Schema,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { ArtifactDeletedDomainEvent } from "../domain/artifact-deleted.domain-event";
import {
  deleteProjectArtifactsInputSchema,
  type ArtifactContract,
} from "../contracts/task-artifact-contracts";
import type { ArtifactRepo } from "./artifact-repo";

type DeleteProjectArtifactsDeps = {
  userAuthz: UserAuthorizationService;
  artifactRepo: ArtifactRepo;
  objectStore: ObjectStore | null;
  orgRepo?: OrgRepo | undefined;
  timeProvider: TimeProvider;
  domainEventDispatcher?: InMemoryDomainEventDispatcher | undefined;
  logger?: Logger | undefined;
  dbExecutor?: DbExecutor | undefined;
};

type ArtifactWithObjectKey = ArtifactContract & { objectKey: string };
const hasObjectKey = (
  artifact: ArtifactContract,
): artifact is ArtifactWithObjectKey => artifact.objectKey !== null;

type ArtifactWithSizeBytes = ArtifactContract & { sizeBytes: number };
const hasSizeBytes = (
  artifact: ArtifactContract,
): artifact is ArtifactWithSizeBytes => artifact.sizeBytes !== null;

const loadRequiredArtifacts = async (
  projectId: UuidV7,
  artifactIds: UuidV7[],
  {
    artifactRepo,
    dbExecutor,
  }: {
    artifactRepo: ArtifactRepo;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<ArtifactContract[], ResourceNotFoundError>> => {
  const found = await artifactRepo.findManyByIds(artifactIds, dbExecutor);
  const byId = new Map(found.map((artifact) => [artifact.id, artifact]));

  const result: ArtifactContract[] = [];
  for (const id of artifactIds) {
    const artifact = byId.get(id);
    // Ownership check prevents IDOR: an id that exists but belongs to a
    // different project must 404, not silently delete/skip.
    if (!artifact || artifact.projectId !== projectId) {
      return Result.err(new ResourceNotFoundError("Artifact", id));
    }
    result.push(artifact);
  }
  return Result.ok(result);
};

/**
 * Best-effort emission of one {@link ArtifactDeletedDomainEvent} per deleted
 * artifact, for usage metering (billing accounts for freed storage). Mirrors
 * `emitArtifactStoredEvent` in `record-task-artifact.ts`, but takes
 * a batch: a project-scoped delete can cover many artifacts at once, and they
 * all share the same owning org (resolved once here rather than per artifact).
 * Any failure is logged and swallowed — billing accounting must never block
 * or roll back an already-completed delete.
 */
const emitArtifactDeletedEvents = async (
  artifacts: Array<{
    taskRunId: UuidV7;
    artifactId: UuidV7;
    sizeBytes: number;
  }>,
  {
    projectId,
    orgRepo,
    domainEventDispatcher,
    logger,
    dbExecutor,
  }: {
    projectId: UuidV7;
    orgRepo?: OrgRepo | undefined;
    domainEventDispatcher?: InMemoryDomainEventDispatcher | undefined;
    logger?: Logger | undefined;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<void> => {
  if (artifacts.length === 0 || !orgRepo || !domainEventDispatcher) {
    return;
  }

  try {
    const db = dbExecutor ?? getDb();
    const org = await orgRepo.findByProjectId(projectId, db);
    if (!org) {
      return;
    }

    await db.transaction(async (tx) => {
      await domainEventDispatcher.publish(
        artifacts.map(
          (artifact) =>
            new ArtifactDeletedDomainEvent({
              orgId: org.id,
              projectId,
              taskRunId: artifact.taskRunId,
              artifactId: artifact.artifactId,
              sizeBytes: artifact.sizeBytes,
            }),
        ),
        tx,
      );
    });
  } catch (error) {
    logger?.error(
      {
        projectId,
        artifactIds: artifacts.map((artifact) => artifact.artifactId),
        error,
      },
      "Failed to emit artifact-deleted usage events",
    );
  }
};

export const deleteProjectArtifacts = async (
  projectIdInput: string,
  artifactIdsInput: string[],
  deps: DeleteProjectArtifactsDeps,
): Promise<Result<number, ResourceNotFoundError>> => {
  const projectId = uuidV7Schema.parse(projectIdInput);
  const artifactIds = deleteProjectArtifactsInputSchema.parse(artifactIdsInput);

  await deps.userAuthz.requireProjectPermission({
    projectId,
    permission: "executions:write",
  });

  const loaded = await loadRequiredArtifacts(projectId, artifactIds, deps);
  if (!loaded.ok) return loaded;

  const deletedIds = await purgeProjectArtifacts(projectId, loaded.value, deps);
  return Result.ok(deletedIds.length);
};

export type PurgeProjectArtifactsDeps = Omit<
  DeleteProjectArtifactsDeps,
  "userAuthz"
>;

/**
 * Deletes already-loaded artifacts of one project, with no authorization
 * check: removes their objects (best-effort), soft-deletes their rows and
 * emits {@link ArtifactDeletedDomainEvent}s for billing. Returns the ids
 * actually deleted. Shared by the user-facing delete and the stale-bundle
 * sweep.
 */
export const purgeProjectArtifacts = async (
  projectId: UuidV7,
  artifacts: ArtifactContract[],
  deps: PurgeProjectArtifactsDeps,
): Promise<UuidV7[]> => {
  if (artifacts.length === 0) {
    return [];
  }

  // Best-effort S3 delete per non-expired artifact (decision 13: failures are
  // logged, never fatal — the 30-day lifecycle rule cleans up any orphan).
  await Promise.all(
    artifacts.filter(hasObjectKey).map(async (artifact) => {
      try {
        await deps.objectStore?.deleteObject(artifact.objectKey);
      } catch (error) {
        deps.logger?.error(
          { artifactId: artifact.id, error },
          "Failed to delete artifact object from S3",
        );
      }
    }),
  );

  const deletedIds = await deps.artifactRepo.softDeleteMany(
    artifacts.map((artifact) => artifact.id),
    deps.timeProvider.now(),
    deps.dbExecutor,
  );

  await emitArtifactDeletedEvents(
    // skip already-expired artifacts (nothing to bill back)
    artifacts.filter(hasSizeBytes).map((artifact) => ({
      taskRunId: artifact.taskRunId,
      artifactId: artifact.id,
      sizeBytes: artifact.sizeBytes,
    })),
    { projectId, ...deps },
  );

  return deletedIds;
};

export const deleteProjectArtifact = async (
  projectIdInput: string,
  artifactIdInput: string,
  deps: DeleteProjectArtifactsDeps,
): Promise<Result<number, ResourceNotFoundError>> =>
  deleteProjectArtifacts(projectIdInput, [artifactIdInput], deps);
