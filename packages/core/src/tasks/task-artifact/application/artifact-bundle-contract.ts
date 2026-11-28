import type { ArtifactBundleContract } from "../contracts/task-artifact-contracts";
import {
  artifactBundleExpiresAt,
  isArtifactBundleExpired,
} from "../domain/artifact-bundle";
import type { ArtifactBundleRecord } from "./artifact-bundle-repo";

/**
 * Project a bundle record onto its API contract as of `now` (drops
 * `deletedAt`/`expiredAt`, adds `expiresAt` and `expired`).
 */
export const toArtifactBundleContract = (
  bundle: ArtifactBundleRecord,
  now: Date,
): ArtifactBundleContract => ({
  id: bundle.id,
  taskRunId: bundle.taskRunId,
  projectId: bundle.projectId,
  name: bundle.name,
  fieldPath: bundle.fieldPath,
  rootPath: bundle.rootPath,
  entryPath: bundle.entryPath,
  status: bundle.status,
  fileCount: bundle.fileCount,
  sizeBytes: bundle.sizeBytes,
  createdAt: bundle.createdAt,
  finalizedAt: bundle.finalizedAt,
  expiresAt: artifactBundleExpiresAt(bundle).toISOString(),
  expired: isArtifactBundleExpired(bundle, now),
});
