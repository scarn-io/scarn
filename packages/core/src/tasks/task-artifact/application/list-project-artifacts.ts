import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import type { ArtifactRepo } from "./artifact-repo";
import type { ArtifactBundleRepo } from "./artifact-bundle-repo";
import { toArtifactBundleContract } from "./artifact-bundle-contract";
import {
  listProjectArtifactsResponseSchema,
  type ListProjectArtifactsResponse,
} from "../contracts/task-artifact-contracts";

const DEFAULT_LIMIT = 50;

/**
 * List artifacts recorded across a project's tasks (newest first),
 * after verifying the caller may read the project's executions. Bundle
 * members stay in `artifacts` with their `bundleId`; `bundles` holds every
 * bundle they reference, so callers can group members under it.
 */
export const listProjectArtifacts = async (
  projectId: string,
  {
    userAuthz,
    artifactRepo,
    artifactBundleRepo,
    timeProvider,
    dbExecutor,
  }: {
    userAuthz: UserAuthorizationService;
    artifactRepo: ArtifactRepo;
    artifactBundleRepo: ArtifactBundleRepo;
    timeProvider: TimeProvider;
    dbExecutor?: DbExecutor;
  },
): Promise<ListProjectArtifactsResponse> => {
  const parsedProjectId = uuidV7Schema.parse(projectId);
  await userAuthz.requireProjectPermission({
    projectId: parsedProjectId,
    permission: "executions:read",
  });

  const rows = await artifactRepo.listByProjectId(
    parsedProjectId,
    DEFAULT_LIMIT,
    dbExecutor,
  );
  const hasMore = rows.length > DEFAULT_LIMIT;
  const artifacts = hasMore ? rows.slice(0, DEFAULT_LIMIT) : rows;

  const bundleIds = [
    ...new Set(
      artifacts.flatMap((artifact) =>
        artifact.bundleId ? [artifact.bundleId] : [],
      ),
    ),
  ];
  const bundles = await artifactBundleRepo.findManyByIds(bundleIds, dbExecutor);
  const now = timeProvider.now();

  return listProjectArtifactsResponseSchema.parse({
    artifacts,
    bundles: bundles.map((bundle) => toArtifactBundleContract(bundle, now)),
    hasMore,
  });
};
