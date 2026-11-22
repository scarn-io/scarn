import {
  artifactFileExtension,
  isEmbeddableArtifactExtension,
} from "@scarn/sdk/contracts/artifacts";
import {
  LinkOnlyCommentArtifactRenderer,
  artifactBaseName,
  artifactPageUrl,
  orderedResolvedMarkers,
  type CommentArtifactRenderer,
  type RenderCommentArtifactsInput,
  type RenderedComment,
} from "@scarn/core/notifications/comment-artifacts/application/comment-artifact-renderer";
import type {
  ArtifactMarker,
  ArtifactMarkerOutcome,
  ResolvedCommentArtifact,
} from "@scarn/core/notifications/comment-artifacts/domain/comment-artifact-types";
import { noopLogger, type Logger } from "@scarn/observability/logging";
import type { JiraConnectionInput } from "./jira-issues-client";
import {
  JiraAttachmentError,
  jiraAttachmentContentUrl,
  lookupJiraMediaId,
  uploadJiraAttachment,
} from "./jira-attachment-uploader";
import {
  adfHardBreak,
  adfLinkMark,
  adfParagraph,
  adfText,
  markdownToAdf,
  type AdfNode,
  type AdfPlaceholder,
} from "./markdown-to-adf";

export type ArtifactBytes = { bytes: Uint8Array; contentType: string | null };

export type JiraCommentArtifactRendererOptions = {
  connection: JiraConnectionInput;
  issueKey: string;
  appBaseUrl: string;
  /** Reads an artifact's bytes from the store, or null when they are gone. */
  readArtifactBytes: (
    artifact: ResolvedCommentArtifact,
  ) => Promise<ArtifactBytes | null>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
};

/** A Jira attachment, with its media UUID when it can be shown inline. */
export type JiraAttachmentRef = {
  attachmentId: string;
  mediaId: string | null;
};

const ATTACHMENT_REF_PREFIX = "jira-attachment:";

export const formatJiraAttachmentRef = (ref: JiraAttachmentRef): string =>
  `${ATTACHMENT_REF_PREFIX}${ref.attachmentId}` +
  (ref.mediaId ? `/media:${ref.mediaId}` : "");

export const parseJiraAttachmentRef = (
  externalRef: string | null,
): JiraAttachmentRef | null => {
  const match = /^jira-attachment:([^/]+)(?:\/media:(.+))?$/.exec(
    externalRef ?? "",
  );
  if (!match?.[1]) return null;
  return { attachmentId: match[1], mediaId: match[2] ?? null };
};

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

const linkNode = (text: string, href: string): AdfNode =>
  adfText(text, [adfLinkMark(href)]);

const withLeadIn = (caption: string, link: AdfNode): AdfPlaceholder => ({
  range: { start: 0, end: 0 },
  block: [
    adfParagraph(caption ? [adfText(caption), adfHardBreak(), link] : [link]),
  ],
  inline: caption ? [adfText(`${caption} `), link] : [link],
});

/**
 * Renders a body for a Jira Cloud comment as ADF. A standalone embed marker
 * whose extension Jira can show is attached to the issue and shown inline
 * under its caption; when Jira gives no media UUID, the caption links to the
 * attachment instead. Every other marker links to its Scarn page.
 *
 * Each upload is reported through `onOutcome` as soon as Jira accepts it,
 * then again once its media UUID is found, so an outcome from an earlier
 * attempt is reused rather than uploaded again. A reused attachment with no
 * media UUID gets one more lookup.
 */
export class JiraCommentArtifactRenderer implements CommentArtifactRenderer {
  readonly platform = "jira" as const;

  constructor(private readonly options: JiraCommentArtifactRendererOptions) {}

  async render(input: RenderCommentArtifactsInput): Promise<RenderedComment> {
    const { body } = await new LinkOnlyCommentArtifactRenderer(
      "jira",
      this.options.appBaseUrl,
    ).render(input);

    const outcomes: ArtifactMarkerOutcome[] = [];
    const placeholders: AdfPlaceholder[] = [];
    for (const { marker, artifact } of orderedResolvedMarkers(input.markers)) {
      const rendered = await this.renderMarker(marker, artifact, input);
      outcomes.push(rendered.outcome);
      placeholders.push({ ...rendered.placeholder, range: marker.range });
    }

    return {
      body,
      document: markdownToAdf(input.body, placeholders),
      outcomes,
    };
  }

  private async renderMarker(
    marker: ArtifactMarker,
    artifact: ResolvedCommentArtifact,
    input: RenderCommentArtifactsInput,
  ): Promise<{ placeholder: AdfPlaceholder; outcome: ArtifactMarkerOutcome }> {
    const outcome = (
      kind: ArtifactMarkerOutcome["outcome"],
      externalRef: string | null,
    ): ArtifactMarkerOutcome => ({
      markerIndex: marker.index,
      artifactId: artifact.artifactId,
      platform: this.platform,
      outcome: kind,
      externalRef,
    });
    const name = artifactBaseName(artifact);
    const caption = marker.caption.trim();
    const pageUrl = artifactPageUrl(
      this.options.appBaseUrl,
      input.projectId,
      artifact.artifactId,
    );

    if (marker.kind === "link") {
      const link = linkNode(caption || name, pageUrl);
      return {
        placeholder: {
          range: marker.range,
          block: [adfParagraph([link])],
          inline: [link],
        },
        outcome: outcome("linked", null),
      };
    }

    const pageLink = (): {
      placeholder: AdfPlaceholder;
      outcome: ArtifactMarkerOutcome;
    } => ({
      placeholder: withLeadIn(
        caption,
        linkNode(`View ${name} in Scarn`, pageUrl),
      ),
      outcome: outcome("linked", null),
    });

    const extension = artifactFileExtension(artifact.name);
    if (
      !marker.standalone ||
      !isEmbeddableArtifactExtension(this.platform, extension)
    ) {
      return pageLink();
    }

    const prior = input.priorOutcomes?.find(
      (candidate) =>
        candidate.markerIndex === marker.index &&
        candidate.artifactId === artifact.artifactId &&
        candidate.platform === this.platform,
    );
    const report = async (ref: JiraAttachmentRef): Promise<void> => {
      await input.onOutcome?.(
        outcome(
          ref.mediaId ? "embedded" : "linked",
          formatJiraAttachmentRef(ref),
        ),
      );
    };
    const reused = parseJiraAttachmentRef(prior?.externalRef ?? null);
    const uploaded =
      reused ?? (await this.upload(artifact, name, extension, report));
    if (!uploaded) return pageLink();
    const attachment = uploaded.mediaId
      ? uploaded
      : await this.findMediaId(artifact, uploaded, report);

    const externalRef = formatJiraAttachmentRef(attachment);
    if (!attachment.mediaId) {
      const contentUrl = jiraAttachmentContentUrl(
        this.options.connection.baseUrl,
        attachment.attachmentId,
      );
      return {
        placeholder: withLeadIn(caption, linkNode(`View ${name}`, contentUrl)),
        outcome: outcome("linked", externalRef),
      };
    }

    const media: AdfNode = {
      type: "mediaSingle",
      attrs: { layout: "center" },
      content: [
        {
          type: "media",
          attrs: {
            type: "file",
            id: attachment.mediaId,
            collection: "",
            alt: caption || name,
          },
        },
      ],
    };
    return {
      placeholder: {
        range: marker.range,
        block: caption ? [adfParagraph([adfText(caption)]), media] : [media],
        inline: [linkNode(caption || name, pageUrl)],
      },
      outcome: outcome("embedded", externalRef),
    };
  }

  private get logger(): Logger {
    return this.options.logger ?? noopLogger;
  }

  /**
   * Uploads an artifact and reports it before any media lookup. Null when
   * its bytes are gone or Jira refuses or times out on the file, so the
   * marker links to Scarn instead; a rejected credential still throws.
   */
  private async upload(
    artifact: ResolvedCommentArtifact,
    fileName: string,
    extension: string,
    report: (ref: JiraAttachmentRef) => Promise<void>,
  ): Promise<JiraAttachmentRef | null> {
    const readStartedAt = performance.now();
    const stored = await this.options.readArtifactBytes(artifact);
    this.logger.info(
      {
        artifactId: artifact.artifactId,
        sizeBytes: stored?.bytes.byteLength ?? null,
        durationMs: Math.round(performance.now() - readStartedAt),
      },
      "jira comment: read artifact bytes",
    );
    if (!stored) return null;

    const uploadStartedAt = performance.now();
    let attachmentId: string;
    try {
      ({ attachmentId } = await uploadJiraAttachment({
        ...this.options.connection,
        issueKey: this.options.issueKey,
        fileName,
        contentType:
          MIME_BY_EXTENSION[extension] ??
          stored.contentType ??
          artifact.contentType ??
          "application/octet-stream",
        bytes: stored.bytes,
        fetchImpl: this.options.fetchImpl,
      }));
    } catch (error) {
      this.logger.warn(
        {
          artifactId: artifact.artifactId,
          sizeBytes: stored.bytes.byteLength,
          durationMs: Math.round(performance.now() - uploadStartedAt),
          status: error instanceof JiraAttachmentError ? error.status : null,
        },
        "jira comment: attachment upload failed",
      );
      if (error instanceof JiraAttachmentError && error.status !== 401) {
        return null;
      }
      throw error;
    }
    this.logger.info(
      {
        artifactId: artifact.artifactId,
        sizeBytes: stored.bytes.byteLength,
        durationMs: Math.round(performance.now() - uploadStartedAt),
      },
      "jira comment: uploaded attachment",
    );

    const ref = { attachmentId, mediaId: null };
    await report(ref);
    return ref;
  }

  /** Looks up an attachment's media UUID and reports it when found. */
  private async findMediaId(
    artifact: ResolvedCommentArtifact,
    attachment: JiraAttachmentRef,
    report: (ref: JiraAttachmentRef) => Promise<void>,
  ): Promise<JiraAttachmentRef> {
    const startedAt = performance.now();
    const mediaId = await lookupJiraMediaId({
      ...this.options.connection,
      attachmentId: attachment.attachmentId,
      fetchImpl: this.options.fetchImpl,
      sleep: this.options.sleep,
    });
    this.logger.info(
      {
        artifactId: artifact.artifactId,
        found: mediaId !== null,
        durationMs: Math.round(performance.now() - startedAt),
      },
      "jira comment: looked up media id",
    );
    if (!mediaId) return attachment;
    const ref = { ...attachment, mediaId };
    await report(ref);
    return ref;
  }
}
