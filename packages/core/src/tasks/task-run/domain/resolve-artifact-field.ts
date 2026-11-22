import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import { artifactAcceptsFile } from "@scarn/sdk/contracts/artifacts";
import type { ArtifactContract } from "@scarn/core/tasks/task-artifact/contracts/task-artifact-contracts";
import type { ArtifactFailureContract } from "@scarn/core/tasks/task-artifact/contracts/task-artifact-failure-contracts";

/**
 * The stored artifact an artifact result field resolved to, or `null` plus
 * the reason it could not be resolved.
 */
export type ResolvedArtifactField =
  | { artifact: ArtifactContract; unavailableReason: null }
  | { artifact: null; unavailableReason: ArtifactUnavailableReason };

export type ArtifactUnavailableReason =
  "not_reported" | "wrong_extension" | "not_found" | `upload_failed:${string}`;

const isUnsafeRelativePath = (reported: string): boolean =>
  reported.startsWith("/") ||
  reported.startsWith("\\") ||
  /^[a-zA-Z]:[\\/]/.test(reported) ||
  reported.split(/[\\/]/).includes("..");

/**
 * Reads the value at a dot path (`a.b.c`) of a Task result. Array paths
 * (`[]`) are not supported and return `undefined`.
 */
export const readResultPath = (
  resultJson: AnyJsonValue | null,
  path: string,
): AnyJsonValue | undefined => {
  let current: AnyJsonValue | undefined = resultJson ?? undefined;
  for (const segment of path.split(".")) {
    if (
      current === undefined ||
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
};

/**
 * Resolves the raw value an agent reported for an artifact field against the
 * task's stored artifacts and upload failures:
 *
 * 1. `null` / missing → `not_reported`.
 * 2. Extension not in `accept` → `wrong_extension` (checked before the
 *    lookup so it is reported even when the upload failed).
 * 3. Matching, non-deleted `task_artifacts` row → the artifact.
 * 4. Matching `task_artifact_failures` row → `upload_failed:<errorCode>`.
 * 5. Otherwise (including `..` / absolute paths) → `not_found`.
 */
export const resolveArtifactField = ({
  rawValue,
  accept,
  artifacts,
  failures,
}: {
  rawValue: AnyJsonValue | undefined;
  accept: readonly string[];
  artifacts: readonly ArtifactContract[];
  failures: readonly ArtifactFailureContract[];
}): ResolvedArtifactField => {
  if (rawValue === undefined || rawValue === null) {
    return { artifact: null, unavailableReason: "not_reported" };
  }

  const reported = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!reported || isUnsafeRelativePath(reported)) {
    return { artifact: null, unavailableReason: "not_found" };
  }

  if (!artifactAcceptsFile(accept, reported)) {
    return { artifact: null, unavailableReason: "wrong_extension" };
  }

  const artifact = artifacts.find(
    (candidate) => candidate.relativeStorePath === reported,
  );
  if (artifact) {
    return { artifact, unavailableReason: null };
  }

  const failure = failures.find(
    (candidate) => candidate.relativeStorePath === reported,
  );
  if (failure) {
    return {
      artifact: null,
      unavailableReason: `upload_failed:${failure.errorCode}`,
    };
  }

  return { artifact: null, unavailableReason: "not_found" };
};
