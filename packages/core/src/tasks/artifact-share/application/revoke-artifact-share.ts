import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { Result } from "@scarn/core/lib/result";
import type { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { ArtifactBundleRepo } from "@scarn/core/tasks/task-artifact/application/artifact-bundle-repo";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import type { ArtifactShareContract } from "../contracts/artifact-share-contracts";
import type { ArtifactSharingConfig } from "../domain/artifact-sharing-config";
import type { ArtifactShareRepo } from "./artifact-share-repo";
import {
  artifactBundleNotFound,
  isBundleShareDeclared,
  loadProjectBundle,
  requireShareManagementPermission,
  toArtifactShareContract,
} from "./artifact-share-view";

/**
 * A person revokes a bundle's share link, so its token stops resolving.
 * Idempotent: revoking a bundle with no active share succeeds. Works even
 * when sharing is disabled or the bundle is expired or deleted, so a link can
 * always be killed. Needs project write permission; public-project
 * non-members are refused.
 */
export const revokeArtifactShare = async (
  projectIdInput: string,
  bundleIdInput: string,
  deps: {
    userAuthz: UserAuthorizationService;
    artifactBundleRepo: ArtifactBundleRepo;
    artifactShareRepo: ArtifactShareRepo;
    artifactSharingConfig: ArtifactSharingConfig;
    taskRunRepo: TaskRunRepo;
    timeProvider: TimeProvider;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<Result<ArtifactShareContract, ResourceNotFoundError>> => {
  const projectId = uuidV7Schema.parse(projectIdInput);
  const bundleId = uuidV7Schema.parse(bundleIdInput);

  await requireShareManagementPermission(
    deps.userAuthz,
    projectId,
    "executions:write",
    deps.dbExecutor,
  );

  const bundle = await loadProjectBundle(
    projectId,
    bundleId,
    deps.artifactBundleRepo,
    deps.dbExecutor,
  );
  if (!bundle) {
    return Result.err(artifactBundleNotFound(bundleId));
  }

  const now = deps.timeProvider.now();
  await deps.artifactShareRepo.revokeActiveByBundle(
    bundle.id,
    { revokedAt: now, revokedByUserId: deps.userAuthz.actorId },
    deps.dbExecutor,
  );
  const shareDeclared = await isBundleShareDeclared(
    bundle,
    deps.taskRunRepo,
    deps.dbExecutor,
  );
  return Result.ok(
    toArtifactShareContract(
      bundle,
      null,
      deps.artifactSharingConfig,
      now,
      shareDeclared,
    ),
  );
};
