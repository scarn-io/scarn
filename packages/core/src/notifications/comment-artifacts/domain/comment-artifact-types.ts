import type { ArtifactPlatform } from "@scarn/sdk/contracts/artifacts";
import type {
  ArtifactMarkerKind,
  ArtifactMarkerRef,
} from "@scarn/sdk/contracts/artifact-markers";

export type { ArtifactMarkerKind, ArtifactMarkerRef };

/** An artifact marker in a comment body. `range` is a pair of string offsets. */
export type ArtifactMarker = {
  index: number;
  kind: ArtifactMarkerKind;
  ref: ArtifactMarkerRef;
  /** The caption (embed) or label (link). */
  caption: string;
  range: { start: number; end: number };
  /** Whether the marker is its own paragraph. Others render as links. */
  standalone: boolean;
};

export type ArtifactMarkerWarning = {
  markerIndex: number;
  code: "marker_not_standalone";
  message: string;
};

export type ParsedArtifactMarkers = {
  markers: ArtifactMarker[];
  warnings: ArtifactMarkerWarning[];
};

export type ResolvedCommentArtifact = {
  artifactId: string;
  name: string;
  contentType: string | null;
  kind: string;
  sizeBytes: number | null;
};

/**
 * Why a marker could not be resolved. Step refs also carry the artifact
 * field's own `unavailable_reason` from `task_artifact_resolutions`
 * (`not_reported`, `wrong_extension`, `not_found`, `upload_failed:<code>`).
 */
export type ArtifactMarkerUnavailableReason =
  | "no_pipeline_run"
  | "invalid_ref"
  | "signal_not_found"
  | "no_match"
  | "deleted"
  | "expired"
  | (string & {});

export type ArtifactMarkerResolution =
  | { status: "resolved"; artifact: ResolvedCommentArtifact }
  | {
      status: "unavailable";
      reason: ArtifactMarkerUnavailableReason;
      required: boolean;
    };

export type ResolvedArtifactMarker = {
  marker: ArtifactMarker;
  resolution: ArtifactMarkerResolution;
};

export type ArtifactMarkerOutcome = {
  markerIndex: number;
  artifactId: string;
  platform: ArtifactPlatform;
  outcome: "embedded" | "linked";
  externalRef: string | null;
};

/** Signal refs are required: a missing artifact suppresses the comment. */
export const isRequiredArtifactMarker = (marker: ArtifactMarker): boolean =>
  marker.ref.type === "signal";
