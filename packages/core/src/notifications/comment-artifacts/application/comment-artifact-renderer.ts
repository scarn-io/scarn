import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import type { ArtifactPlatform } from "@scarn/sdk/contracts/artifacts";
import type {
  ArtifactMarkerOutcome,
  ResolvedArtifactMarker,
  ResolvedCommentArtifact,
  StoredArtifactMarkerOutcome,
} from "../domain/comment-artifact-types";

export type RenderCommentArtifactsInput = {
  body: string;
  /** Every marker in `body`, all resolved. */
  markers: readonly ResolvedArtifactMarker[];
  projectId: string;
  /**
   * Outcomes stored by an earlier, failed attempt. A renderer that uploads
   * reuses any of these with an `externalRef` instead of uploading again.
   */
  priorOutcomes?: readonly StoredArtifactMarkerOutcome[];
  /** Called after each upload, before the comment is posted. */
  onOutcome?: (outcome: ArtifactMarkerOutcome) => Promise<void>;
};

export type RenderedComment = {
  /** The markdown body, with every marker as a Scarn link. */
  body: string;
  /** The platform's own document format (Jira ADF), when it has one. */
  document: AnyJsonObject | null;
  outcomes: ArtifactMarkerOutcome[];
};

/** Turns a body's artifact markers into what a platform's comment shows. */
export interface CommentArtifactRenderer {
  readonly platform: ArtifactPlatform;
  render(input: RenderCommentArtifactsInput): Promise<RenderedComment>;
}

/** The Scarn page for an artifact. */
export const artifactPageUrl = (
  appBaseUrl: string,
  projectId: string,
  artifactId: string,
): string =>
  `${appBaseUrl.replace(/\/+$/, "")}/projects/${projectId}/artifacts/${artifactId}`;

const escapeLinkText = (value: string): string =>
  value.replace(/[\\[\]]/g, "\\$&");

export const artifactBaseName = (artifact: ResolvedCommentArtifact): string =>
  artifact.name.slice(artifact.name.lastIndexOf("/") + 1);

/** The resolved markers in body order; throws on an unavailable one. */
export const orderedResolvedMarkers = (
  markers: readonly ResolvedArtifactMarker[],
): Array<{
  marker: ResolvedArtifactMarker["marker"];
  artifact: ResolvedCommentArtifact;
}> =>
  [...markers]
    .sort((a, b) => a.marker.range.start - b.marker.range.start)
    .map(({ marker, resolution }) => {
      if (resolution.status !== "resolved") {
        throw new Error(
          `Artifact marker ${String(marker.index)} is unavailable and cannot be rendered`,
        );
      }
      return { marker, artifact: resolution.artifact };
    });

/**
 * Renders every marker as a markdown link to the artifact's Scarn page. An
 * embed marker keeps its caption as a lead-in line. GitHub and Bitbucket use
 * this.
 */
export class LinkOnlyCommentArtifactRenderer implements CommentArtifactRenderer {
  constructor(
    readonly platform: ArtifactPlatform,
    private readonly appBaseUrl: string,
  ) {}

  render(input: RenderCommentArtifactsInput): Promise<RenderedComment> {
    const outcomes: ArtifactMarkerOutcome[] = [];

    let body = "";
    let cursor = 0;
    for (const { marker, artifact } of orderedResolvedMarkers(input.markers)) {
      const url = artifactPageUrl(
        this.appBaseUrl,
        input.projectId,
        artifact.artifactId,
      );
      const name = escapeLinkText(artifactBaseName(artifact));
      const caption = marker.caption.trim();
      const link =
        marker.kind === "link"
          ? `[${escapeLinkText(caption || artifactBaseName(artifact))}](${url})`
          : `[View ${name} in Scarn](${url})`;
      const rendered =
        marker.kind === "embed" && caption
          ? `${caption}${marker.standalone ? "\n" : " "}${link}`
          : link;

      body += input.body.slice(cursor, marker.range.start) + rendered;
      cursor = marker.range.end;
      outcomes.push({
        markerIndex: marker.index,
        artifactId: artifact.artifactId,
        platform: this.platform,
        outcome: "linked",
        externalRef: null,
      });
    }
    body += input.body.slice(cursor);

    return Promise.resolve({ body, document: null, outcomes });
  }
}
