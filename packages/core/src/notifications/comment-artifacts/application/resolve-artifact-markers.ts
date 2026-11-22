import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  isRequiredArtifactMarker,
  type ArtifactMarker,
  type ArtifactMarkerResolution,
  type ResolvedArtifactMarker,
  type ResolvedCommentArtifact,
} from "../domain/comment-artifact-types";
import { matchesArtifactGlob } from "../domain/match-artifact-glob";
import type {
  CommentArtifactReader,
  RunArtifact,
} from "./comment-artifact-reader";

export type ResolveArtifactMarkersDeps = {
  commentArtifactReader: CommentArtifactReader;
  dbExecutor?: DbExecutor;
};

const toResolved = (artifact: RunArtifact): ResolvedCommentArtifact => ({
  artifactId: artifact.id,
  name: artifact.relativeStorePath,
  contentType: artifact.contentType,
  kind: artifact.kind,
  sizeBytes: artifact.sizeBytes,
});

const unavailabilityOf = (artifact: RunArtifact): string | null =>
  artifact.deletedAt ? "deleted" : artifact.storeRef ? null : "expired";

/**
 * Resolves each marker against the run's artifacts:
 *
 * - Step refs (`artifact:signal/<step>/<result path>`) read how that artifact
 *   field of the step's newest non-superseded visit resolved, and use its
 *   artifact or its `unavailable_reason`. They are required.
 * - Path refs glob over the run's non-deleted artifacts; the newest match
 *   that hasn't expired wins. They are optional.
 *
 * An artifact that has since been deleted or expired is unavailable.
 */
export const resolveArtifactMarkers = async (
  markers: readonly ArtifactMarker[],
  context: { pipelineRunId: UuidV7 | null },
  deps: ResolveArtifactMarkersDeps,
): Promise<ResolvedArtifactMarker[]> => {
  const { pipelineRunId } = context;
  const unavailable = (
    marker: ArtifactMarker,
    reason: string,
  ): ArtifactMarkerResolution => ({
    status: "unavailable",
    reason,
    required: isRequiredArtifactMarker(marker),
  });

  if (markers.length === 0) return [];
  if (pipelineRunId === null) {
    return markers.map((marker) => ({
      marker,
      resolution: unavailable(marker, "no_pipeline_run"),
    }));
  }

  const artifacts = await deps.commentArtifactReader.listRunArtifacts(
    pipelineRunId,
    deps.dbExecutor,
  );

  const resolveOne = async (
    marker: ArtifactMarker,
  ): Promise<ArtifactMarkerResolution> => {
    if (marker.ref.type === "path") {
      const { pattern } = marker.ref;
      const matches = artifacts.filter(
        (artifact) =>
          artifact.deletedAt === null &&
          matchesArtifactGlob(pattern, artifact.relativeStorePath),
      );
      if (matches.length === 0) return unavailable(marker, "no_match");
      const available = matches.find((artifact) => artifact.storeRef !== null);
      return available
        ? { status: "resolved", artifact: toResolved(available) }
        : unavailable(marker, "expired");
    }

    const { stepKey, signalKey: resultPath } = marker.ref;
    if (!stepKey || !resultPath) return unavailable(marker, "invalid_ref");
    const resolution = await deps.commentArtifactReader.findLatestStepArtifact(
      { pipelineRunId, stepKey, resultPath },
      deps.dbExecutor,
    );
    if (!resolution) return unavailable(marker, "signal_not_found");
    const { artifactId } = resolution;
    if (!artifactId) {
      return unavailable(
        marker,
        resolution.unavailableReason ?? "not_reported",
      );
    }
    const artifact = artifacts.find((candidate) => candidate.id === artifactId);
    if (!artifact) return unavailable(marker, "not_found");
    const reason = unavailabilityOf(artifact);
    return reason
      ? unavailable(marker, reason)
      : { status: "resolved", artifact: toResolved(artifact) };
  };

  const resolved: ResolvedArtifactMarker[] = [];
  for (const marker of markers) {
    resolved.push({ marker, resolution: await resolveOne(marker) });
  }
  return resolved;
};
