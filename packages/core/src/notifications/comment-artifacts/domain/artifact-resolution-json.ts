import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import { readStoredArtifactMarkerOutcomes } from "../contracts/artifact-resolution-stored";
import type { LeftOutArtifactMarker } from "./apply-artifact-resolution";
import {
  isRequiredArtifactMarker,
  type ArtifactMarkerOutcome,
  type ArtifactMarkerRef,
  type ArtifactMarkerWarning,
  type ResolvedArtifactMarker,
  type StoredArtifactMarkerOutcome,
} from "./comment-artifact-types";

/**
 * What `notification_deliveries.artifact_resolution_json` holds: the
 * per-marker resolution of the body (at draft time, then again at approval)
 * and, once approved, the per-marker outcomes on the platform.
 */
export type ArtifactResolutionJson = {
  markers: Array<{
    markerIndex: number;
    kind: string;
    ref: AnyJsonObject;
    caption: string;
    standalone: boolean;
    status: "resolved" | "unavailable";
    required: boolean;
    reason: string | null;
    artifact: AnyJsonObject | null;
  }>;
  leftOut: Array<{
    markerIndex: number;
    ref: AnyJsonObject;
    caption: string;
    reason: string;
  }>;
  warnings: Array<{ markerIndex: number; code: string; message: string }>;
  outcomes: StoredArtifactMarkerOutcome[] | null;
};

const refJson = (ref: ArtifactMarkerRef): AnyJsonObject =>
  ref.type === "signal"
    ? { type: "signal", stepKey: ref.stepKey, signalKey: ref.signalKey }
    : { type: "path", pattern: ref.pattern };

/** The per-marker outcomes stored on a delivery, skipping malformed entries. */
export const readArtifactMarkerOutcomes = readStoredArtifactMarkerOutcomes;

/** Adds an outcome to stored resolution JSON, replacing the marker's old one. */
export const recordArtifactMarkerOutcome = (
  json: AnyJsonObject | null,
  outcome: ArtifactMarkerOutcome,
): AnyJsonObject => {
  const outcomes = [
    ...readArtifactMarkerOutcomes(json).filter(
      (existing) => existing.markerIndex !== outcome.markerIndex,
    ),
    outcome,
  ].sort((a, b) => a.markerIndex - b.markerIndex);
  return JSON.parse(
    JSON.stringify({
      markers: [],
      leftOut: [],
      warnings: [],
      ...json,
      outcomes,
    }),
  ) as AnyJsonObject;
};

export const buildArtifactResolutionJson = (input: {
  markers: readonly ResolvedArtifactMarker[];
  leftOut?: readonly LeftOutArtifactMarker[];
  warnings: readonly ArtifactMarkerWarning[];
  outcomes?: readonly ArtifactMarkerOutcome[];
}): AnyJsonObject => {
  const json: ArtifactResolutionJson = {
    markers: input.markers.map(({ marker, resolution }) => ({
      markerIndex: marker.index,
      kind: marker.kind,
      ref: refJson(marker.ref),
      caption: marker.caption,
      standalone: marker.standalone,
      status: resolution.status,
      required: isRequiredArtifactMarker(marker),
      reason: resolution.status === "unavailable" ? resolution.reason : null,
      artifact:
        resolution.status === "resolved" ? { ...resolution.artifact } : null,
    })),
    leftOut: (input.leftOut ?? []).map((entry) => ({
      markerIndex: entry.markerIndex,
      ref: refJson(entry.ref),
      caption: entry.caption,
      reason: entry.reason,
    })),
    warnings: input.warnings.map((warning) => ({ ...warning })),
    outcomes: input.outcomes ? [...input.outcomes] : null,
  };
  return JSON.parse(JSON.stringify(json)) as AnyJsonObject;
};
