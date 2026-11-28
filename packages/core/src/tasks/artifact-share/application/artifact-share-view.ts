import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreError, ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { ProjectPermission } from "@scarn/core/projects/project/domain/project-permission";
import type {
  ArtifactBundleRecord,
  ArtifactBundleRepo,
} from "@scarn/core/tasks/task-artifact/application/artifact-bundle-repo";
import {
  artifactBundleExpiresAt,
  isArtifactBundleExpired,
} from "@scarn/core/tasks/task-artifact/domain/artifact-bundle";
import { findBundleField } from "@scarn/core/tasks/task-artifact/domain/bundle-field";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { ArtifactShareContract } from "../contracts/artifact-share-contracts";
import type { ArtifactShareStatus } from "../domain/artifact-share";
import {
  artifactShareUrl,
  type ArtifactSharingConfig,
} from "../domain/artifact-sharing-config";
import { buildShareToken } from "../domain/share-token";
import type { ArtifactShareRecord } from "./artifact-share-repo";

const shareStatus = (
  bundle: ArtifactBundleRecord,
  share: ArtifactShareRecord | null,
  config: ArtifactSharingConfig,
  now: Date,
): ArtifactShareStatus => {
  if (bundle.deletedAt !== null) return "deleted";
  if (isArtifactBundleExpired(bundle, now)) return "expired";
  if (!config.enabled) return "unavailable";
  return share ? "shared" : "private";
};

const shareUrlFor = (
  share: ArtifactShareRecord,
  config: ArtifactSharingConfig,
): string | null =>
  config.contentUrl && config.shareSecret
    ? artifactShareUrl(
        config.contentUrl,
        buildShareToken(config.shareSecret, share.id),
      )
    : null;

/**
 * Does the bundle fill a field its Task's result schema declares with
 * `share: true` (ADR 0020)? An undeclared bundle, or one whose run is gone,
 * is not.
 */
export const isBundleShareDeclared = async (
  bundle: ArtifactBundleRecord,
  taskRunRepo: TaskRunRepo,
  dbExecutor?: DbExecutor,
): Promise<boolean> => {
  if (bundle.fieldPath === null) return false;
  const run = await taskRunRepo.load(bundle.taskRunId, dbExecutor);
  if (!run) return false;
  return (
    findBundleField(run.resultSchemaJson, bundle.fieldPath)?.share ?? false
  );
};

/**
 * Project a bundle and its active share (if any) onto the share contract as
 * of `now`. The link is rebuilt from the share id, and only returned while
 * the share actually works (`status: "shared"`).
 */
export const toArtifactShareContract = (
  bundle: ArtifactBundleRecord,
  share: ArtifactShareRecord | null,
  config: ArtifactSharingConfig,
  now: Date,
  shareDeclared: boolean,
): ArtifactShareContract => {
  const status = shareStatus(bundle, share, config, now);
  return {
    bundleId: bundle.id,
    status,
    reason: status === "unavailable" ? "sharing_disabled" : null,
    url: status === "shared" && share ? shareUrlFor(share, config) : null,
    expiresAt: artifactBundleExpiresAt(bundle).toISOString(),
    shareDeclared,
    share: share
      ? {
          id: share.id,
          createdVia: share.createdVia,
          createdAt: share.createdAt,
        }
      : null,
  };
};

/**
 * Check the caller may manage a project's share links. Sharing is always
 * explicit (plan decision 8): a public project's read grant to a non-member
 * never counts, so they are refused like any non-member.
 */
export const requireShareManagementPermission = async (
  userAuthz: UserAuthorizationService,
  projectId: UuidV7,
  permission: ProjectPermission,
  dbExecutor?: DbExecutor,
): Promise<void> => {
  const grant = await userAuthz.requireProjectPermission({
    projectId,
    permission,
    dbExecutor,
  });
  if (grant.isPublicNonMemberGrant) {
    throw new CoreError({
      code: "PROJECT_FORBIDDEN",
      message: "You are not a member of this project",
      status: 403,
      meta: { permission },
    });
  }
};

/**
 * Load a project's bundle, including a soft-deleted one so its share can
 * report `deleted`. A bundle of another project is reported as not found.
 */
export const loadProjectBundle = async (
  projectId: UuidV7,
  bundleId: UuidV7,
  artifactBundleRepo: ArtifactBundleRepo,
  dbExecutor?: DbExecutor,
): Promise<ArtifactBundleRecord | null> => {
  const bundle = await artifactBundleRepo.findByIdIncludingDeleted(
    bundleId,
    dbExecutor,
  );
  return bundle && bundle.projectId === projectId ? bundle : null;
};

export const artifactBundleNotFound = (bundleId: UuidV7) =>
  new ResourceNotFoundError("Artifact bundle", bundleId);
