import { ARTIFACT_ARCHIVE_PREFIX } from "@scarn/core/billing/usage-meter/domain/storage-retention";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";

/**
 * Validate and normalize a caller-supplied relative store path for an artifact.
 *
 * Rejects anything that could escape the artifact's key prefix or is otherwise
 * unsafe: empty paths, absolute paths (leading `/`), backslashes, and any `..`
 * traversal segment. Leading `./` and redundant slashes are collapsed. The
 * result is a clean, forward-slash relative path safe to embed in an object key.
 */
export const normalizeRelativeStorePath = (
  relativeStorePath: string,
): string => {
  const trimmed = relativeStorePath.trim();

  if (trimmed.length === 0) {
    throw new CoreValidationError(
      "relativeStorePath must not be empty",
      "INVALID_ARTIFACT_PATH",
    );
  }
  if (trimmed.includes("\\")) {
    throw new CoreValidationError(
      `relativeStorePath must not contain backslashes: ${relativeStorePath}`,
      "INVALID_ARTIFACT_PATH",
    );
  }
  if (trimmed.startsWith("/")) {
    throw new CoreValidationError(
      `relativeStorePath must be relative, not absolute: ${relativeStorePath}`,
      "INVALID_ARTIFACT_PATH",
    );
  }

  const segments = trimmed
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");

  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw new CoreValidationError(
      `relativeStorePath must not contain ".." traversal or be empty: ${relativeStorePath}`,
      "INVALID_ARTIFACT_PATH",
    );
  }

  return segments.join("/");
};

/**
 * Derive the deterministic object-storage key for a task artifact.
 * Both the upload-URL and record flows call this so the key can never be spoofed
 * by the client: `artifacts/<projectId>/<taskRunId>/<normalizedPath>`.
 */
export const deriveArtifactObjectKey = (input: {
  projectId: UuidV7;
  taskRunId: UuidV7;
  relativeStorePath: string;
}): string => {
  const normalized = normalizeRelativeStorePath(input.relativeStorePath);
  return `${artifactRunPrefix(input)}${normalized}`;
};

/** The prefix holding every artifact a run stored: `artifacts/<projectId>/<taskRunId>/`. */
export const artifactRunPrefix = (input: {
  projectId: UuidV7;
  taskRunId: UuidV7;
}): string =>
  `${ARTIFACT_ARCHIVE_PREFIX}${input.projectId}/${input.taskRunId}/`;
