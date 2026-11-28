import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { Result } from "@scarn/core/lib/result";
import type { ResourceNotFoundError } from "@scarn/core/lib/errors";
import {
  createUuidV7,
  uuidV7Schema,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { ArtifactBundleRepo } from "@scarn/core/tasks/task-artifact/application/artifact-bundle-repo";
import type { TaskRunRepo } from "@scarn/core/tasks/task-run/application/task-run-repo";
import { isArtifactBundleExpired } from "@scarn/core/tasks/task-artifact/domain/artifact-bundle";
import type { ArtifactShareContract } from "../contracts/artifact-share-contracts";
import {
  ArtifactBundleNotShareableError,
  ArtifactSharingDisabledError,
  type ArtifactShareCreatedVia,
} from "../domain/artifact-share";
import type { ArtifactSharingConfig } from "../domain/artifact-sharing-config";
import type { ArtifactShareRepo } from "./artifact-share-repo";
import {
  artifactBundleNotFound,
  isBundleShareDeclared,
  requireShareManagementPermission,
  toArtifactShareContract,
} from "./artifact-share-view";

export type ShareArtifactBundleDeps = {
  artifactBundleRepo: ArtifactBundleRepo;
  artifactShareRepo: ArtifactShareRepo;
  artifactSharingConfig: ArtifactSharingConfig;
  taskRunRepo: TaskRunRepo;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor | undefined;
};

export type ShareArtifactBundleError =
  | ResourceNotFoundError
  | ArtifactSharingDisabledError
  | ArtifactBundleNotShareableError;

export type ShareArtifactBundleAsSystemInput = {
  projectId: UuidV7;
  bundleId: UuidV7;
  createdVia: ArtifactShareCreatedVia;
  createdByUserId: UuidV7 | null;
  createdByTaskId: UuidV7 | null;
};

/**
 * Share a bundle with no permission check: the caller has already decided
 * the share is allowed (a person's request, or a step definition that
 * declares `share: true`). Idempotent: returns the bundle's existing active
 * share when it has one. The bundle must belong to `projectId`, be `ready`
 * and not expired, and sharing must be configured.
 */
export const shareArtifactBundleAsSystem = async (
  input: ShareArtifactBundleAsSystemInput,
  deps: ShareArtifactBundleDeps,
): Promise<Result<ArtifactShareContract, ShareArtifactBundleError>> => {
  const { artifactSharingConfig: config, dbExecutor } = deps;
  if (!config.enabled) {
    return Result.err(new ArtifactSharingDisabledError());
  }

  const bundle = await deps.artifactBundleRepo.findById(
    input.bundleId,
    dbExecutor,
  );
  if (!bundle || bundle.projectId !== input.projectId) {
    return Result.err(artifactBundleNotFound(input.bundleId));
  }

  const now = deps.timeProvider.now();
  if (bundle.status !== "ready") {
    return Result.err(
      new ArtifactBundleNotShareableError(bundle.id, "not_ready", {
        status: bundle.status,
      }),
    );
  }
  if (isArtifactBundleExpired(bundle, now)) {
    return Result.err(
      new ArtifactBundleNotShareableError(bundle.id, "expired"),
    );
  }

  const share = await deps.artifactShareRepo.createOrGetActive(
    {
      id: createUuidV7(),
      projectId: bundle.projectId,
      bundleId: bundle.id,
      createdVia: input.createdVia,
      createdByUserId: input.createdByUserId,
      createdByTaskId: input.createdByTaskId,
    },
    dbExecutor,
  );
  const shareDeclared = await isBundleShareDeclared(
    bundle,
    deps.taskRunRepo,
    dbExecutor,
  );
  return Result.ok(
    toArtifactShareContract(bundle, share, config, now, shareDeclared),
  );
};

/**
 * A person shares a bundle of a project they can write to. Public-project
 * non-members are refused (plan decision 8). See
 * {@link shareArtifactBundleAsSystem} for the rules on the bundle itself.
 */
export const shareArtifactBundle = async (
  projectIdInput: string,
  bundleIdInput: string,
  deps: ShareArtifactBundleDeps & { userAuthz: UserAuthorizationService },
): Promise<Result<ArtifactShareContract, ShareArtifactBundleError>> => {
  const projectId = uuidV7Schema.parse(projectIdInput);
  const bundleId = uuidV7Schema.parse(bundleIdInput);

  await requireShareManagementPermission(
    deps.userAuthz,
    projectId,
    "executions:write",
    deps.dbExecutor,
  );

  return shareArtifactBundleAsSystem(
    {
      projectId,
      bundleId,
      createdVia: "person",
      createdByUserId: deps.userAuthz.actorId,
      createdByTaskId: null,
    },
    deps,
  );
};
