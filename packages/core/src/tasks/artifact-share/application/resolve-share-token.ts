import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type {
  ArtifactBundleRecord,
  ArtifactBundleRepo,
} from "@scarn/core/tasks/task-artifact/application/artifact-bundle-repo";
import { isArtifactBundleExpired } from "@scarn/core/tasks/task-artifact/domain/artifact-bundle";
import type { ArtifactSharingConfig } from "../domain/artifact-sharing-config";
import { verifyShareToken } from "../domain/share-token";
import type {
  ArtifactShareRecord,
  ArtifactShareRepo,
} from "./artifact-share-repo";

/**
 * Why a share token does not resolve. `expired` is reported separately so
 * the content origin can show a "this artifact has expired" page (plan
 * decision 5); every other reason should look like a plain 404.
 */
export type ShareTokenRejection =
  | "sharing_disabled"
  | "invalid_token"
  | "revoked"
  | "not_ready"
  | "deleted"
  | "expired";

export type ResolvedShareToken =
  | { ok: true; share: ArtifactShareRecord; bundle: ArtifactBundleRecord }
  | { ok: false; reason: ShareTokenRejection };

const reject = (reason: ShareTokenRejection): ResolvedShareToken => ({
  ok: false,
  reason,
});

/**
 * Resolve an anonymous share-link token to its bundle. The bundle is
 * returned only when sharing is configured, the token's MAC verifies, the
 * share is active, and the bundle is `ready`, not deleted and not expired.
 * No user permission is involved: the token is the grant.
 */
export const resolveShareToken = async (
  token: string,
  deps: {
    artifactShareRepo: ArtifactShareRepo;
    artifactBundleRepo: ArtifactBundleRepo;
    artifactSharingConfig: ArtifactSharingConfig;
    timeProvider: TimeProvider;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<ResolvedShareToken> => {
  const { shareSecret } = deps.artifactSharingConfig;
  if (!deps.artifactSharingConfig.enabled || !shareSecret) {
    return reject("sharing_disabled");
  }

  const shareId = verifyShareToken(shareSecret, token);
  if (!shareId) {
    return reject("invalid_token");
  }

  const share = await deps.artifactShareRepo.findById(shareId, deps.dbExecutor);
  if (!share) {
    return reject("invalid_token");
  }
  if (share.revokedAt !== null) {
    return reject("revoked");
  }

  const bundle = await deps.artifactBundleRepo.findByIdIncludingDeleted(
    share.bundleId,
    deps.dbExecutor,
  );
  if (!bundle || bundle.deletedAt !== null) {
    return reject("deleted");
  }
  if (isArtifactBundleExpired(bundle, deps.timeProvider.now())) {
    return reject("expired");
  }
  if (bundle.status !== "ready") {
    return reject("not_ready");
  }
  return { ok: true, share, bundle };
};
