import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { ArtifactBundleRepo } from "@scarn/core/tasks/task-artifact/application/artifact-bundle-repo";
import {
  listProjectArtifactSharesResponseSchema,
  type ListProjectArtifactSharesResponse,
} from "../contracts/artifact-share-contracts";
import type { ArtifactSharingConfig } from "../domain/artifact-sharing-config";
import type { ArtifactShareRepo } from "./artifact-share-repo";
import {
  requireShareManagementPermission,
  toArtifactShareContract,
} from "./artifact-share-view";

const DEFAULT_LIMIT = 50;

/**
 * A project's active (non-revoked) share links on non-deleted bundles,
 * newest first and capped at 50 (`hasMore` says more exist), for the
 * settings list. Only project members may see them, even on a public
 * project: the URLs themselves grant read access.
 */
export const listProjectArtifactShares = async (
  projectIdInput: string,
  deps: {
    userAuthz: UserAuthorizationService;
    artifactBundleRepo: ArtifactBundleRepo;
    artifactShareRepo: ArtifactShareRepo;
    artifactSharingConfig: ArtifactSharingConfig;
    timeProvider: TimeProvider;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<ListProjectArtifactSharesResponse> => {
  const projectId = uuidV7Schema.parse(projectIdInput);

  await requireShareManagementPermission(
    deps.userAuthz,
    projectId,
    "executions:read",
    deps.dbExecutor,
  );

  const rows = await deps.artifactShareRepo.listActiveByProject(
    projectId,
    DEFAULT_LIMIT,
    deps.dbExecutor,
  );
  const hasMore = rows.length > DEFAULT_LIMIT;
  const shares = hasMore ? rows.slice(0, DEFAULT_LIMIT) : rows;

  const bundles = await deps.artifactBundleRepo.findManyByIds(
    shares.map((share) => share.bundleId),
    deps.dbExecutor,
  );
  const bundlesById = new Map(bundles.map((bundle) => [bundle.id, bundle]));
  const now = deps.timeProvider.now();

  return listProjectArtifactSharesResponseSchema.parse({
    shares: shares.flatMap((share) => {
      const bundle = bundlesById.get(share.bundleId);
      if (!bundle) return [];
      const view = toArtifactShareContract(
        bundle,
        share,
        deps.artifactSharingConfig,
        now,
        false,
      );
      return [
        {
          id: share.id,
          bundleId: bundle.id,
          bundleName: bundle.name,
          taskRunId: bundle.taskRunId,
          status: view.status,
          url: view.url,
          createdVia: share.createdVia,
          createdAt: share.createdAt,
          expiresAt: view.expiresAt,
        },
      ];
    }),
    hasMore,
  });
};
