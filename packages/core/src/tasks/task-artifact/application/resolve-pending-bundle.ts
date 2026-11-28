import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  CoreValidationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  ARTIFACT_BUNDLE_LIMITS,
  assertBundleMemberSize,
  bundleRelativePath,
  type ArtifactBundleLimits,
} from "../domain/artifact-bundle";
import { ArtifactBundleNotPendingError } from "../domain/artifact-bundle-not-pending-error";
import type {
  ArtifactBundleRecord,
  ArtifactBundleRepo,
} from "./artifact-bundle-repo";

/**
 * Load the bundle a member upload targets and check it can take the file: the
 * bundle must belong to `taskRunId` and still be `pending`, the store path must
 * lie under its root, and a known size must fit the per-file limit. A bundle
 * from another task run is reported as not found.
 */
export const resolvePendingBundleForMember = async (
  input: {
    bundleId: UuidV7;
    taskRunId: UuidV7;
    relativeStorePath: string;
    sizeBytes?: number | undefined;
  },
  {
    artifactBundleRepo,
    artifactBundleLimits = ARTIFACT_BUNDLE_LIMITS,
    dbExecutor,
  }: {
    artifactBundleRepo: ArtifactBundleRepo;
    artifactBundleLimits?: ArtifactBundleLimits | undefined;
    dbExecutor?: DbExecutor | undefined;
  },
): Promise<
  Result<
    ArtifactBundleRecord,
    ResourceNotFoundError | CoreValidationError | ArtifactBundleNotPendingError
  >
> => {
  const bundle = await artifactBundleRepo.findById(input.bundleId, dbExecutor);
  if (!bundle || bundle.taskRunId !== input.taskRunId) {
    return Result.err(
      new ResourceNotFoundError("Artifact bundle", input.bundleId),
    );
  }
  if (bundle.status !== "pending") {
    return Result.err(
      new ArtifactBundleNotPendingError(bundle.id, bundle.status),
    );
  }
  if (bundleRelativePath(bundle.rootPath, input.relativeStorePath) === null) {
    return Result.err(
      new CoreValidationError(
        `relativeStorePath ${input.relativeStorePath} is not under the bundle root ${bundle.rootPath}`,
        "ARTIFACT_BUNDLE_PATH_OUTSIDE_ROOT",
        { rootPath: bundle.rootPath },
      ),
    );
  }
  if (input.sizeBytes !== undefined) {
    assertBundleMemberSize(input.sizeBytes, artifactBundleLimits);
  }
  return Result.ok(bundle);
};
