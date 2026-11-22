import { findArtifactMarkers } from "@scarn/sdk/contracts/artifact-markers";
import type {
  ArtifactMarker,
  ArtifactMarkerWarning,
  ParsedArtifactMarkers,
} from "./comment-artifact-types";

export type ParagraphBounds = { start: number; end: number };

const isBlank = (line: string): boolean => line.trim().length === 0;

/**
 * The paragraph (a run of non-blank lines) containing `offset`. `end` is the
 * end of the paragraph's last line, before its line break.
 */
export const paragraphAt = (body: string, offset: number): ParagraphBounds => {
  let start = body.lastIndexOf("\n", offset - 1) + 1;
  while (start > 0) {
    const previousStart = body.lastIndexOf("\n", start - 2) + 1;
    if (isBlank(body.slice(previousStart, start - 1))) break;
    start = previousStart;
  }

  let end = body.indexOf("\n", offset);
  if (end === -1) return { start, end: body.length };
  while (end < body.length) {
    const nextEnd = body.indexOf("\n", end + 1);
    const lineEnd = nextEnd === -1 ? body.length : nextEnd;
    if (isBlank(body.slice(end + 1, lineEnd))) break;
    end = lineEnd;
  }
  return { start, end };
};

/**
 * Finds every artifact marker in a comment body. A marker that shares its
 * paragraph with other text is still returned, with `standalone: false` and
 * a warning; it renders as a link.
 */
export const parseArtifactMarkers = (body: string): ParsedArtifactMarkers => {
  const warnings: ArtifactMarkerWarning[] = [];
  const markers = findArtifactMarkers(body).map(
    (match, index): ArtifactMarker => {
      const paragraph = paragraphAt(body, match.start);
      const standalone =
        body.slice(paragraph.start, paragraph.end).trim() ===
        body.slice(match.start, match.end);
      if (!standalone) {
        warnings.push({
          markerIndex: index,
          code: "marker_not_standalone",
          message:
            `Artifact marker "${body.slice(match.start, match.end)}" is not ` +
            "its own paragraph, so it will be shown as a link.",
        });
      }
      return {
        index,
        kind: match.kind,
        ref: match.ref,
        caption: match.text,
        range: { start: match.start, end: match.end },
        standalone,
      };
    },
  );
  return { markers, warnings };
};
