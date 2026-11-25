import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreError, CoreValidationError } from "@scarn/core/lib/errors";
import type { ArtifactPlatform } from "@scarn/sdk/contracts/artifacts";
import { parseArtifactMarkers } from "@scarn/core/notifications/comment-artifacts/domain/parse-artifact-markers";
import { buildArtifactResolutionJson } from "@scarn/core/notifications/comment-artifacts/domain/artifact-resolution-json";
import type {
  ArtifactMarkerOutcome,
  ArtifactMarkerWarning,
  ResolvedArtifactMarker,
  StoredArtifactMarkerOutcome,
} from "@scarn/core/notifications/comment-artifacts/domain/comment-artifact-types";
import {
  resolveArtifactMarkers,
  type ResolveArtifactMarkersDeps,
} from "@scarn/core/notifications/comment-artifacts/application/resolve-artifact-markers";
import {
  LinkOnlyCommentArtifactRenderer,
  type CommentArtifactRenderer,
} from "@scarn/core/notifications/comment-artifacts/application/comment-artifact-renderer";

export const ARTIFACT_UNAVAILABLE_ERROR_CODE = "artifact_unavailable";

export type RenderedCommentDraft = {
  body: string;
  /** The platform's own document (Jira ADF), when its renderer made one. */
  document: AnyJsonObject | null;
  /** Null when the body has no markers. */
  artifactResolutionJson: AnyJsonObject | null;
};

/** A body whose markers have all been resolved, ready to render. */
export type ResolvedCommentDraft = {
  body: string;
  projectId: UuidV7;
  platform: ArtifactPlatform | null;
  appBaseUrl: string | null;
  markers: ResolvedArtifactMarker[];
  warnings: ArtifactMarkerWarning[];
};

export type RenderCommentDraftOptions = {
  /** Replaces the link-only renderer, e.g. to embed on Jira. */
  renderer?: (appBaseUrl: string) => CommentArtifactRenderer;
  priorOutcomes?: readonly StoredArtifactMarkerOutcome[];
  onOutcome?: (outcome: ArtifactMarkerOutcome) => Promise<void>;
};

/**
 * Re-resolves every artifact marker in an approved body. Any unavailable
 * marker blocks approval: the reviewer removes the marker or rejects the
 * draft.
 */
export const resolveCommentDraftArtifacts = async (
  input: {
    body: string;
    projectId: UuidV7;
    pipelineRunId: UuidV7 | null;
    platform: ArtifactPlatform | null;
    appBaseUrl: string | null;
  },
  deps: ResolveArtifactMarkersDeps,
): Promise<ResolvedCommentDraft> => {
  const { markers, warnings } = parseArtifactMarkers(input.body);
  const resolved = await resolveArtifactMarkers(
    markers,
    { pipelineRunId: input.pipelineRunId },
    deps,
  );
  const unavailable = resolved.flatMap(({ marker, resolution }) =>
    resolution.status === "unavailable"
      ? [
          {
            markerIndex: marker.index,
            caption: marker.caption,
            reason: resolution.reason,
          },
        ]
      : [],
  );
  if (unavailable.length > 0) {
    throw new CoreValidationError(
      "One or more artifacts in this comment are no longer available",
      ARTIFACT_UNAVAILABLE_ERROR_CODE,
      { markers: unavailable },
    );
  }

  if (resolved.length > 0 && input.platform !== null && !input.appBaseUrl) {
    throw new CoreError({
      code: "MISSING_CONFIG",
      message: "APP_URL environment variable is not set",
      status: 500,
    });
  }

  return {
    body: input.body,
    projectId: input.projectId,
    platform: input.platform,
    appBaseUrl: input.appBaseUrl,
    markers: resolved,
    warnings,
  };
};

/** Renders a resolved body's markers for its work item's platform. */
export const renderCommentDraftArtifacts = async (
  draft: ResolvedCommentDraft,
  options: RenderCommentDraftOptions = {},
): Promise<RenderedCommentDraft> => {
  if (draft.markers.length === 0) {
    return { body: draft.body, document: null, artifactResolutionJson: null };
  }

  if (draft.platform === null || !draft.appBaseUrl) {
    return {
      body: draft.body,
      document: null,
      artifactResolutionJson: buildArtifactResolutionJson({
        markers: draft.markers,
        warnings: draft.warnings,
      }),
    };
  }

  const renderer =
    options.renderer?.(draft.appBaseUrl) ??
    new LinkOnlyCommentArtifactRenderer(draft.platform, draft.appBaseUrl);
  const rendered = await renderer.render({
    body: draft.body,
    markers: draft.markers,
    projectId: draft.projectId,
    priorOutcomes: options.priorOutcomes,
    onOutcome: options.onOutcome,
  });
  return {
    body: rendered.body,
    document: rendered.document,
    artifactResolutionJson: buildArtifactResolutionJson({
      markers: draft.markers,
      warnings: draft.warnings,
      outcomes: rendered.outcomes,
    }),
  };
};
