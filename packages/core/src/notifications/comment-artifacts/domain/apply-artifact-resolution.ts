import type {
  ArtifactMarkerRef,
  ArtifactMarkerUnavailableReason,
  ResolvedArtifactMarker,
} from "./comment-artifact-types";
import { paragraphAt, parseArtifactMarkers } from "./parse-artifact-markers";

export type LeftOutArtifactMarker = {
  markerIndex: number;
  ref: ArtifactMarkerRef;
  caption: string;
  reason: ArtifactMarkerUnavailableReason;
};

export type AppliedArtifactResolution = {
  body: string;
  /** The markers still in `body`, re-indexed against it. */
  markers: ResolvedArtifactMarker[];
  leftOut: LeftOutArtifactMarker[];
};

type Removal = { start: number; end: number };

const paragraphRemoval = (
  body: string,
  start: number,
  end: number,
): Removal => {
  const trailing = /^(?:[ \t]*\n)*/.exec(body.slice(end))?.[0] ?? "";
  const rest = body.slice(end + trailing.length);
  if (rest.trim().length > 0) return { start, end: end + trailing.length };
  const leading = /\s*$/.exec(body.slice(0, start))?.[0] ?? "";
  return { start: start - leading.length, end: body.length };
};

const inlineRemoval = (body: string, start: number, end: number): Removal =>
  body.charAt(start - 1) === " " && /^[ \t]/.test(body.charAt(end))
    ? { start: start - 1, end }
    : { start, end };

/**
 * Removes unavailable optional markers: a standalone marker takes its whole
 * paragraph with it, an inline one only itself. Required markers are left
 * alone; callers suppress the comment instead.
 */
export const applyResolution = (
  body: string,
  resolutions: readonly ResolvedArtifactMarker[],
): AppliedArtifactResolution => {
  const removals: Removal[] = [];
  const leftOut: LeftOutArtifactMarker[] = [];
  const kept: ResolvedArtifactMarker[] = [];

  for (const entry of resolutions) {
    const { marker, resolution } = entry;
    if (resolution.status === "resolved" || resolution.required) {
      kept.push(entry);
      continue;
    }
    leftOut.push({
      markerIndex: marker.index,
      ref: marker.ref,
      caption: marker.caption,
      reason: resolution.reason,
    });
    if (marker.standalone) {
      const paragraph = paragraphAt(body, marker.range.start);
      removals.push(paragraphRemoval(body, paragraph.start, paragraph.end));
    } else {
      removals.push(inlineRemoval(body, marker.range.start, marker.range.end));
    }
  }

  let next = body;
  for (const removal of removals.sort((a, b) => b.start - a.start)) {
    next = next.slice(0, removal.start) + next.slice(removal.end);
  }

  const reparsed = parseArtifactMarkers(next).markers;
  const markers = kept.map((entry, index) => {
    const marker = reparsed[index];
    return marker ? { ...entry, marker } : entry;
  });

  return { body: next, markers, leftOut };
};
