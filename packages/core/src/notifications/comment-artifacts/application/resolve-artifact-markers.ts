import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { isArtifactBundleExpired } from "@scarn/core/tasks/task-artifact/domain/artifact-bundle";
import {
  artifactShareUrl,
  type ArtifactSharingConfig,
} from "@scarn/core/tasks/artifact-share/domain/artifact-sharing-config";
import { buildShareToken } from "@scarn/core/tasks/artifact-share/domain/share-token";
import {
  BUNDLE_COMMENT_ARTIFACT_KIND,
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
  RunArtifactBundle,
} from "./comment-artifact-reader";

export type ResolveArtifactMarkersDeps = {
  commentArtifactReader: CommentArtifactReader;
  /** Builds a shared bundle's link; without it bundles link to their page. */
  artifactSharingConfig?: ArtifactSharingConfig;
  timeProvider?: TimeProvider;
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

const bundleUnavailabilityOf = (
  bundle: RunArtifactBundle,
  now: Date,
): string | null => {
  if (bundle.deletedAt) return "deleted";
  if (isArtifactBundleExpired(bundle, now)) return "expired";
  return bundle.status === "ready" ? null : "bundle_not_ready";
};

const bundleShareUrl = (
  bundle: RunArtifactBundle,
  config: ArtifactSharingConfig | undefined,
): string | null =>
  bundle.activeShareId &&
  config?.enabled &&
  config.contentUrl &&
  config.shareSecret
    ? artifactShareUrl(
        config.contentUrl,
        buildShareToken(config.shareSecret, bundle.activeShareId),
      )
    : null;

const BUNDLE_REF_SUFFIX = "/";

/**
 * Resolves each marker against the run's artifacts:
 *
 * - Step refs (`artifact:signal/<step>/<result path>`) read how that artifact
 *   field of the step's newest non-superseded visit resolved, and use its
 *   artifact or its `unavailable_reason`. They are required.
 * - Path refs glob over the run's non-deleted artifacts; the newest match
 *   that hasn't expired wins. They are optional.
 *
 * Both resolve to bundles too: a step ref whose field a bundle filled
 * resolves to that bundle, and a path ref ending in `/` (`artifact:<name>/`)
 * globs over the run's non-deleted bundle names, the newest ready unexpired
 * match winning. A resolved bundle carries its share link when it has an
 * active share and sharing is enabled.
 *
 * An artifact or bundle that has since been deleted or expired, or a bundle
 * that never became ready, is unavailable.
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

  const now = deps.timeProvider?.now() ?? new Date();
  const artifacts = await deps.commentArtifactReader.listRunArtifacts(
    pipelineRunId,
    deps.dbExecutor,
  );
  let runBundles: Promise<RunArtifactBundle[]> | null = null;
  const listRunBundles = (): Promise<RunArtifactBundle[]> => {
    runBundles ??= deps.commentArtifactReader.listRunBundles(
      pipelineRunId,
      deps.dbExecutor,
    );
    return runBundles;
  };

  const resolvedBundle = (
    bundle: RunArtifactBundle,
  ): ArtifactMarkerResolution => ({
    status: "resolved",
    artifact: {
      artifactId: bundle.id,
      name: bundle.name,
      contentType: null,
      kind: BUNDLE_COMMENT_ARTIFACT_KIND,
      sizeBytes: null,
      bundle: { shareUrl: bundleShareUrl(bundle, deps.artifactSharingConfig) },
    },
  });

  const resolveBundlePath = async (
    marker: ArtifactMarker,
    pattern: string,
  ): Promise<ArtifactMarkerResolution> => {
    const namePattern = pattern.slice(0, -BUNDLE_REF_SUFFIX.length);
    const matches = (await listRunBundles()).filter(
      (bundle) =>
        bundle.deletedAt === null &&
        matchesArtifactGlob(namePattern, bundle.name),
    );
    if (matches.length === 0) return unavailable(marker, "no_match");
    const available = matches.find(
      (bundle) => bundleUnavailabilityOf(bundle, now) === null,
    );
    if (available) return resolvedBundle(available);
    return unavailable(
      marker,
      matches.some((bundle) => isArtifactBundleExpired(bundle, now))
        ? "expired"
        : "bundle_not_ready",
    );
  };

  const resolveOne = async (
    marker: ArtifactMarker,
  ): Promise<ArtifactMarkerResolution> => {
    if (marker.ref.type === "path") {
      const { pattern } = marker.ref;
      if (pattern.endsWith(BUNDLE_REF_SUFFIX)) {
        return resolveBundlePath(marker, pattern);
      }
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
    const bundle = await deps.commentArtifactReader.findLatestStepBundle(
      { pipelineRunId, stepKey, fieldPath: resultPath },
      deps.dbExecutor,
    );
    if (bundle) {
      const reason = bundleUnavailabilityOf(bundle, now);
      return reason ? unavailable(marker, reason) : resolvedBundle(bundle);
    }
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
