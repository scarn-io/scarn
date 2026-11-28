import type { Logger } from "@scarn/observability/logging";
import type { ObjectStore } from "@scarn/core/artifacts/object-store";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { InMemoryDomainEventDispatcher } from "@scarn/core/lib/domain-events/in-memory-domain-event-dispatcher";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { OrgRepo } from "@scarn/core/organizations/organization/application/org-repo";
import type { ArtifactBundleRepo } from "@scarn/core/tasks/task-artifact/application/artifact-bundle-repo";
import type { ArtifactRepo } from "@scarn/core/tasks/task-artifact/application/artifact-repo";
import { purgeProjectArtifacts } from "@scarn/core/tasks/task-artifact/application/delete-project-artifacts";
import { STALE_PENDING_ARTIFACT_BUNDLE_MS } from "@scarn/core/tasks/task-artifact/domain/artifact-bundle";

export type SweepStaleArtifactBundlesDeps = {
  artifactBundleRepo: ArtifactBundleRepo;
  artifactRepo: ArtifactRepo;
  /** Null when object storage isn't configured; member rows are still deleted. */
  objectStore: ObjectStore | null;
  orgRepo?: OrgRepo | undefined;
  domainEventDispatcher?: InMemoryDomainEventDispatcher | undefined;
  timeProvider: TimeProvider;
  logger?: Logger | undefined;
  /** Bundles handled per invocation. Defaults to the repo's limit (500). */
  limit?: number | undefined;
  dbExecutor?: DbExecutor | undefined;
};

export type SweepStaleArtifactBundlesResult = {
  /** Bundles moved from `pending` to `failed`. */
  failed: number;
  /** Member artifacts deleted from those bundles. */
  membersDeleted: number;
};

/**
 * SCHEDULED maintenance use case (no auth actor): a bundle still `pending`
 * {@link STALE_PENDING_ARTIFACT_BUNDLE_MS} after creation was abandoned
 * mid-upload. Marks it `failed` (so no more members can attach), then deletes
 * the members it did get: objects best-effort, rows soft-deleted, storage
 * credited back. A bundle finalized concurrently is left alone. Idempotent.
 */
export const sweepStaleArtifactBundles = async (
  deps: SweepStaleArtifactBundlesDeps,
): Promise<SweepStaleArtifactBundlesResult> => {
  const { artifactBundleRepo, timeProvider, logger, dbExecutor } = deps;
  const now = timeProvider.now();
  const stale = await artifactBundleRepo.listStalePending(
    new Date(now.getTime() - STALE_PENDING_ARTIFACT_BUNDLE_MS),
    deps.limit,
    dbExecutor,
  );

  let failed = 0;
  let membersDeleted = 0;
  for (const bundle of stale) {
    const finalized = await artifactBundleRepo.finalize(
      bundle.id,
      { status: "failed" },
      now,
      dbExecutor,
    );
    if (!finalized) {
      continue;
    }
    failed++;

    const members = await artifactBundleRepo.listMembers(bundle.id, dbExecutor);
    const deleted = await purgeProjectArtifacts(
      bundle.projectId,
      members,
      deps,
    );
    membersDeleted += deleted.length;
  }

  if (failed > 0) {
    logger?.info(
      { failed, membersDeleted },
      "Failed stale pending artifact bundles and deleted their members",
    );
  }

  return { failed, membersDeleted };
};
