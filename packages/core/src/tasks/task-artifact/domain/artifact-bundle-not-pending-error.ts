import { CoreError } from "@scarn/core/lib/errors";
import type { ArtifactBundleStatus } from "./artifact-bundle";

/**
 * The bundle has already been finalized (or failed), so it no longer accepts
 * members or a second finalize.
 */
export class ArtifactBundleNotPendingError extends CoreError {
  constructor(bundleId: string, status: ArtifactBundleStatus | "unknown") {
    super({
      code: "ARTIFACT_BUNDLE_NOT_PENDING",
      message: `Artifact bundle ${bundleId} is ${status}, not pending`,
      status: 409,
      meta: { bundleId, status },
    });
  }
}
