import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { Result } from "@scarn/core/lib/result";
import type { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import {
  artifactBundleNotFound,
  loadProjectBundle,
  requireShareManagementPermission,
} from "@scarn/core/tasks/artifact-share/application/artifact-share-view";
import {
  projectArtifactBundleDetailSchema,
  type ProjectArtifactBundleDetailContract,
} from "../contracts/task-artifact-contracts";
import type { ArtifactBundleRepo } from "./artifact-bundle-repo";
import { toArtifactBundleContract } from "./artifact-bundle-contract";

/**
 * A project's bundle with its member files, for the dashboard's bundle page.
 * A soft-deleted bundle is still returned (`deleted: true`, no members) so
 * the page can say what happened. A bundle of another project is not found.
 * Like the share routes, it needs `executions:read` and refuses
 * public-project non-members (plan decision 8).
 */
export const getProjectArtifactBundle = async (
  projectIdInput: string,
  bundleIdInput: string,
  deps: {
    userAuthz: UserAuthorizationService;
    artifactBundleRepo: ArtifactBundleRepo;
    timeProvider: TimeProvider;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<
  Result<ProjectArtifactBundleDetailContract, ResourceNotFoundError>
> => {
  const projectId = uuidV7Schema.parse(projectIdInput);
  const bundleId = uuidV7Schema.parse(bundleIdInput);

  await requireShareManagementPermission(
    deps.userAuthz,
    projectId,
    "executions:read",
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

  const deleted = bundle.deletedAt !== null;
  const members = deleted
    ? []
    : await deps.artifactBundleRepo.listMembers(bundle.id, deps.dbExecutor);

  return Result.ok(
    projectArtifactBundleDetailSchema.parse({
      ...toArtifactBundleContract(bundle, deps.timeProvider.now()),
      deleted,
      members,
    }),
  );
};
