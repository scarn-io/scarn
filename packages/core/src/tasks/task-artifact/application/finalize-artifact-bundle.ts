import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor, DbTransaction } from "@scarn/core/lib/db/db-executor";
import {
  CoreValidationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { Logger } from "@scarn/observability/logging";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { InMemoryDomainEventDispatcher } from "@scarn/core/lib/domain-events/in-memory-domain-event-dispatcher";
import {
  uuidV7Schema,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  getTaskRunInputSchema,
  type GetTaskRunInput,
} from "@scarn/core/tasks/task-run/contracts/task-run-contracts";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import { assertClaimOwnership } from "@scarn/core/tasks/task-run/application/task-run-claim-helpers";
import {
  ARTIFACT_BUNDLE_LIMITS,
  bundleRelativePath,
  checkBundleManifest,
  type ArtifactBundleLimits,
  type BundleManifestEntry,
  type BundleTotals,
} from "../domain/artifact-bundle";
import { ArtifactBundleNotPendingError } from "../domain/artifact-bundle-not-pending-error";
import { ArtifactBundleReadyDomainEvent } from "../domain/artifact-bundle-ready.domain-event";
import {
  finalizeArtifactBundleInputSchema,
  type ArtifactBundleContract,
  type FinalizeArtifactBundleInput,
} from "../contracts/task-artifact-contracts";
import type {
  ArtifactBundleRecord,
  ArtifactBundleRepo,
} from "./artifact-bundle-repo";
import { toArtifactBundleContract } from "./artifact-bundle-contract";
import { findBundleField } from "../domain/bundle-field";
import type { ArtifactShareRepo } from "@scarn/core/tasks/artifact-share/application/artifact-share-repo";
import {
  shareArtifactBundleAsSystem,
  type ShareArtifactBundleDeps,
} from "@scarn/core/tasks/artifact-share/application/share-artifact-bundle";
import type { ArtifactSharingConfig } from "@scarn/core/tasks/artifact-share/domain/artifact-sharing-config";

/**
 * Mark a `pending` bundle `ready` once its recorded members match the posted
 * manifest (root-relative paths and sizes), the entry page is present and the
 * bundle fits the limits, then emit {@link ArtifactBundleReadyDomainEvent}.
 * Requires `executions:write` and the worker's claim. A bundle filling a
 * field the Task's result schema declares with `share: true` is then shared
 * (`created_via: "step"`); the policy comes only from the Task, never the
 * request (ADR 0020).
 *
 * A mismatch is rejected with a 422 `CoreValidationError` and the bundle stays
 * `pending`, so the client can upload what is missing and retry; bundles that
 * are never finalized are swept as abandoned. Finalizing an already-`ready`
 * bundle with a matching manifest is an idempotent success (no second event);
 * any other finalize of a non-pending bundle is a 409
 * {@link ArtifactBundleNotPendingError}.
 */
export const finalizeArtifactBundle = async (
  taskIdInput: GetTaskRunInput,
  bundleIdInput: string,
  input: FinalizeArtifactBundleInput,
  {
    userAuthz,
    taskRunRepo,
    artifactBundleRepo,
    artifactBundleLimits = ARTIFACT_BUNDLE_LIMITS,
    artifactShareRepo,
    artifactSharingConfig,
    orgRepo,
    timeProvider,
    domainEventDispatcher,
    logger,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    taskRunRepo: TaskRunRepo;
    artifactBundleRepo: ArtifactBundleRepo;
    artifactBundleLimits?: ArtifactBundleLimits | undefined;
    artifactShareRepo: ArtifactShareRepo;
    artifactSharingConfig: ArtifactSharingConfig;
    orgRepo?: OrgRepo | undefined;
    timeProvider: TimeProvider;
    domainEventDispatcher?: InMemoryDomainEventDispatcher | undefined;
    logger?: Logger | undefined;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<
  Result<
    ArtifactBundleContract,
    ResourceNotFoundError | CoreValidationError | ArtifactBundleNotPendingError
  >
> => {
  const taskRunId = getTaskRunInputSchema.parse(taskIdInput);
  const bundleId = uuidV7Schema.parse(bundleIdInput);
  const parsedInput = finalizeArtifactBundleInputSchema.parse(input);
  const db = dbExecutor ?? getDb();

  return db.transaction(async (tx) => {
    const task = await taskRunRepo.load(taskRunId, tx);
    if (!task) {
      return Result.err(new ResourceNotFoundError("Task", taskRunId));
    }
    await userAuthz.requireProjectPermission({
      projectId: task.projectId,
      permission: "executions:write",
    });

    assertClaimOwnership(task, parsedInput.claimToken, timeProvider.now());

    const bundle = await artifactBundleRepo.findById(bundleId, tx);
    if (!bundle || bundle.taskRunId !== task.id) {
      return Result.err(new ResourceNotFoundError("Artifact bundle", bundleId));
    }
    if (bundle.status === "ready") {
      const sameManifest = await isSameReadyBundle(
        bundle,
        parsedInput.manifest,
        {
          artifactBundleRepo,
          artifactBundleLimits,
          tx,
        },
      );
      return sameManifest
        ? Result.ok(toArtifactBundleContract(bundle, timeProvider.now()))
        : Result.err(
            new ArtifactBundleNotPendingError(bundle.id, bundle.status),
          );
    }
    if (bundle.status !== "pending") {
      return Result.err(
        new ArtifactBundleNotPendingError(bundle.id, bundle.status),
      );
    }

    const totals = await checkMembers(bundle, parsedInput.manifest, {
      artifactBundleRepo,
      artifactBundleLimits,
      tx,
    });

    const finalized = await artifactBundleRepo.finalize(
      bundle.id,
      { status: "ready", ...totals },
      timeProvider.now(),
      tx,
    );
    if (!finalized) {
      return Result.err(
        new ArtifactBundleNotPendingError(bundle.id, "unknown"),
      );
    }

    await emitArtifactBundleReadyEvent(
      {
        projectId: finalized.projectId,
        taskRunId: finalized.taskRunId,
        bundleId: finalized.id,
        ...totals,
      },
      { orgRepo, domainEventDispatcher, logger, dbExecutor: tx },
    );

    if (finalized.fieldPath !== null) {
      const field = findBundleField(task.resultSchemaJson, finalized.fieldPath);
      if (field?.share) {
        await autoShareBundle(
          {
            projectId: finalized.projectId,
            taskId: task.taskId,
            taskRunId: finalized.taskRunId,
            bundleId: finalized.id,
          },
          {
            artifactBundleRepo,
            artifactShareRepo,
            artifactSharingConfig,
            taskRunRepo,
            timeProvider,
            logger,
            dbExecutor: tx,
          },
        );
      }
    }

    return Result.ok(toArtifactBundleContract(finalized, timeProvider.now()));
  });
};

/**
 * Share a bundle that fills a declared `share: true` field (ADR 0020), in a
 * savepoint of the finalize transaction so the share commits with the
 * `ready` transition. Never fails the finalize: a server with sharing
 * disabled is skipped quietly (the bundle page reports it would have been
 * shared), and any other refusal or error is logged and swallowed, leaving
 * the bundle private for a person to share by hand.
 */
const autoShareBundle = async (
  bundle: {
    projectId: UuidV7;
    taskId: UuidV7;
    taskRunId: UuidV7;
    bundleId: UuidV7;
  },
  deps: Omit<ShareArtifactBundleDeps, "dbExecutor"> & {
    logger?: Logger | undefined;
    dbExecutor: DbTransaction;
  },
): Promise<void> => {
  if (!deps.artifactSharingConfig.enabled) {
    return;
  }

  try {
    const shared = await deps.dbExecutor.transaction((sp) =>
      shareArtifactBundleAsSystem(
        {
          projectId: bundle.projectId,
          bundleId: bundle.bundleId,
          createdVia: "step",
          createdByUserId: null,
          createdByTaskId: bundle.taskId,
        },
        { ...deps, dbExecutor: sp },
      ),
    );
    if (!shared.ok) {
      deps.logger?.warn(
        {
          taskRunId: bundle.taskRunId,
          bundleId: bundle.bundleId,
          error: shared.error,
        },
        "Declared bundle field was not auto-shared",
      );
    }
  } catch (error) {
    deps.logger?.error(
      { taskRunId: bundle.taskRunId, bundleId: bundle.bundleId, error },
      "Failed to auto-share declared bundle field",
    );
  }
};

const checkMembers = async (
  bundle: ArtifactBundleRecord,
  manifest: readonly BundleManifestEntry[],
  {
    artifactBundleRepo,
    artifactBundleLimits,
    tx,
  }: {
    artifactBundleRepo: ArtifactBundleRepo;
    artifactBundleLimits: ArtifactBundleLimits;
    tx: DbTransaction;
  },
): Promise<BundleTotals> => {
  const members = await artifactBundleRepo.listMembers(bundle.id, tx);
  return checkBundleManifest({
    entryPath: bundle.entryPath,
    manifest,
    members: members.map((member) => ({
      path:
        bundleRelativePath(bundle.rootPath, member.relativeStorePath) ??
        member.relativeStorePath,
      sizeBytes: member.sizeBytes,
    })),
    limits: artifactBundleLimits,
  });
};

/** True when a repeated finalize posts the manifest the bundle was finalized with. */
const isSameReadyBundle = async (
  bundle: ArtifactBundleRecord,
  manifest: readonly BundleManifestEntry[],
  deps: {
    artifactBundleRepo: ArtifactBundleRepo;
    artifactBundleLimits: ArtifactBundleLimits;
    tx: DbTransaction;
  },
): Promise<boolean> => {
  try {
    const totals = await checkMembers(bundle, manifest, deps);
    return (
      totals.fileCount === bundle.fileCount &&
      totals.sizeBytes === bundle.sizeBytes
    );
  } catch (error) {
    if (error instanceof CoreValidationError) {
      return false;
    }
    throw error;
  }
};

/**
 * Best-effort emission of {@link ArtifactBundleReadyDomainEvent}, mirroring
 * `emitArtifactStoredEvent` in `record-task-artifact.ts`: published in a
 * savepoint of the active transaction, with failures logged and swallowed so
 * they never undo the finalize. Only emitted when `orgRepo` and
 * `domainEventDispatcher` are wired.
 */
const emitArtifactBundleReadyEvent = async (
  bundle: {
    projectId: UuidV7;
    taskRunId: UuidV7;
    bundleId: UuidV7;
    fileCount: number;
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
    const org = await orgRepo.findByProjectId(bundle.projectId, dbExecutor);
    if (!org) {
      return;
    }

    await dbExecutor.transaction(async (tx) => {
      await domainEventDispatcher.publish(
        [new ArtifactBundleReadyDomainEvent({ orgId: org.id, ...bundle })],
        tx,
      );
    });
  } catch (error) {
    logger?.error(
      { taskRunId: bundle.taskRunId, bundleId: bundle.bundleId, error },
      "Failed to emit artifact-bundle-ready event",
    );
  }
};
