import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { applyResolution } from "../domain/apply-artifact-resolution";
import { buildArtifactResolutionJson } from "../domain/artifact-resolution-json";
import { parseArtifactMarkers } from "../domain/parse-artifact-markers";
import {
  resolveArtifactMarkers,
  type ResolveArtifactMarkersDeps,
} from "./resolve-artifact-markers";

export const ARTIFACT_UNAVAILABLE_SUPPRESSION_REASON = "artifact_unavailable";

export type PreparedCommentDraft =
  | {
      status: "ready";
      body: string;
      /** Null when the body has no markers. */
      artifactResolutionJson: AnyJsonObject | null;
    }
  | {
      status: "suppressed";
      /** Goes into the notification's `payloadJson.commentSuppressed`. */
      commentSuppressed: AnyJsonObject;
    };

/**
 * Resolves a comment draft's artifact markers when the draft is created. A
 * required marker that can't be resolved suppresses the draft; unavailable
 * optional markers are removed with their paragraphs.
 */
export const prepareCommentDraftArtifacts = async (
  body: string,
  context: { pipelineRunId: UuidV7 | null },
  deps: ResolveArtifactMarkersDeps,
): Promise<PreparedCommentDraft> => {
  const { markers } = parseArtifactMarkers(body);
  if (markers.length === 0) {
    return { status: "ready", body, artifactResolutionJson: null };
  }

  const resolutions = await resolveArtifactMarkers(markers, context, deps);
  const blocking = resolutions.find(
    ({ resolution }) =>
      resolution.status === "unavailable" && resolution.required,
  );
  if (blocking && blocking.resolution.status === "unavailable") {
    const { marker } = blocking;
    return {
      status: "suppressed",
      commentSuppressed: {
        reason: blocking.resolution.reason,
        artifact:
          marker.ref.type === "signal"
            ? {
                stepKey: marker.ref.stepKey,
                signalKey: marker.ref.signalKey,
                caption: marker.caption,
              }
            : { pattern: marker.ref.pattern, caption: marker.caption },
      },
    };
  }

  const applied = applyResolution(body, resolutions);
  return {
    status: "ready",
    body: applied.body,
    artifactResolutionJson: buildArtifactResolutionJson({
      markers: applied.markers,
      leftOut: applied.leftOut,
      warnings: parseArtifactMarkers(applied.body).warnings,
    }),
  };
};
