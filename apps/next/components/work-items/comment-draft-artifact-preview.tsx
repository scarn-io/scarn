"use client";

import { Fragment, useMemo } from "react";
import Link from "next/link";
import { Box, Chip, Paper, Stack, Typography } from "@mui/material";
import {
  findArtifactMarkers,
  formatArtifactMarkerRef,
  type ArtifactMarkerMatch,
} from "@scarn/sdk/contracts/artifact-markers";
import type { CommentDraftArtifactResolutionContract } from "@scarn/api/frontend-contracts";
import { Prose } from "@/components/executions/prose";
import {
  ArtifactMediaPreview,
  DELETED_MESSAGE,
  EXPIRED_MESSAGE,
} from "@/components/artifacts/artifact-media-preview";
import { artifactPagePath } from "@/components/artifacts/artifact-page-path";
import { humanizeArtifactMarkerReason } from "@/components/artifacts/artifact-marker-reason";
import {
  useArtifactDownloadUrl,
  useProjectArtifact,
} from "@/components/artifacts/use-artifact-download-url";

type ResolvedMarker = CommentDraftArtifactResolutionContract["markers"][number];

type Segment =
  | { type: "text"; text: string }
  | {
      type: "embed";
      match: ArtifactMarkerMatch;
      resolved: ResolvedMarker | null;
    };

const escapeLinkText = (text: string) => text.replace(/[\\[\]]/g, "\\$&");

const resolvedByRef = (
  resolution: CommentDraftArtifactResolutionContract | null,
): Map<string, ResolvedMarker> =>
  new Map(
    (resolution?.markers ?? []).map((marker) => [
      formatArtifactMarkerRef(marker.ref),
      marker,
    ]),
  );

const isStandalone = (body: string, match: ArtifactMarkerMatch): boolean => {
  const before = body.slice(0, match.start);
  const after = body.slice(match.end);
  return (
    /(^|\n[ \t]*\n)[ \t]*$/.test(before) &&
    /^[ \t]*(\n[ \t]*\n|\n?$)/.test(after)
  );
};

/**
 * Splits a draft body into prose and standalone embed markers. Link and
 * inline markers become ordinary markdown links to the artifact page, or the
 * bare caption when the artifact is unavailable.
 */
const toSegments = (
  body: string,
  projectId: string,
  resolution: CommentDraftArtifactResolutionContract | null,
): Segment[] => {
  const byRef = resolvedByRef(resolution);
  const segments: Segment[] = [];
  let text = "";
  let cursor = 0;
  for (const match of findArtifactMarkers(body)) {
    text += body.slice(cursor, match.start);
    cursor = match.end;
    const resolved = byRef.get(formatArtifactMarkerRef(match.ref)) ?? null;
    if (match.kind === "embed" && isStandalone(body, match)) {
      segments.push({ type: "text", text });
      segments.push({ type: "embed", match, resolved });
      text = "";
      continue;
    }
    const artifactId = resolved?.artifact?.artifactId;
    text += artifactId
      ? `[${escapeLinkText(match.text)}](${artifactPagePath(projectId, artifactId)})`
      : match.text;
  }
  segments.push({ type: "text", text: text + body.slice(cursor) });
  return segments.filter(
    (segment) => segment.type === "embed" || segment.text.trim().length > 0,
  );
};

function ResolvedEmbedPreview({
  projectId,
  artifactId,
  kind,
  name,
}: {
  projectId: string;
  artifactId: string;
  kind: string;
  name: string;
}) {
  const artifactState = useProjectArtifact(projectId, artifactId);
  const artifact =
    artifactState.status === "loaded" ? artifactState.artifact : null;
  const { state } = useArtifactDownloadUrl(artifact, {
    auto: artifact?.status === "available",
  });
  if (artifactState.status === "error") {
    return (
      <Typography variant="caption" color="text.secondary">
        {artifactState.message}
      </Typography>
    );
  }
  if (artifact && artifact.status !== "available") {
    return (
      <ArtifactMediaPreview
        kind={kind}
        name={name}
        state={{
          status: "error",
          message:
            artifact.status === "deleted" ? DELETED_MESSAGE : EXPIRED_MESSAGE,
        }}
      />
    );
  }
  return <ArtifactMediaPreview kind={kind} name={name} state={state} />;
}

function EmbedMarkerPreview({
  projectId,
  match,
  resolved,
}: {
  projectId: string;
  match: ArtifactMarkerMatch;
  resolved: ResolvedMarker | null;
}) {
  const artifact = resolved?.artifact ?? null;
  return (
    <Paper variant="outlined" sx={{ p: 1.25 }}>
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {match.text || "Untitled artifact"}
          </Typography>
          {artifact ? (
            <Typography
              variant="caption"
              component={Link}
              href={artifactPagePath(projectId, artifact.artifactId)}
              target="_blank"
              rel="noopener"
              sx={{ color: "primary.main", fontFamily: "var(--font-mono)" }}
            >
              {artifact.name}
            </Typography>
          ) : (
            <Chip
              size="small"
              variant="outlined"
              color="warning"
              label={
                resolved?.reason
                  ? `Unavailable: ${humanizeArtifactMarkerReason(resolved.reason)}`
                  : "Not checked yet — approve to check this file"
              }
            />
          )}
        </Stack>
        {artifact ? (
          <ResolvedEmbedPreview
            projectId={projectId}
            artifactId={artifact.artifactId}
            kind={artifact.kind}
            name={artifact.name}
          />
        ) : null}
      </Stack>
    </Paper>
  );
}

/**
 * Read-only preview of a draft body with its artifact markers shown the way
 * reviewers should picture them: embeds as inline video/image previews,
 * links as links to the artifact page.
 */
export function CommentDraftBodyPreview({
  body,
  projectId,
  resolution,
}: {
  body: string;
  projectId: string;
  resolution: CommentDraftArtifactResolutionContract | null;
}) {
  const segments = useMemo(
    () => toSegments(body, projectId, resolution),
    [body, projectId, resolution],
  );
  return (
    <Box>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ fontWeight: 600, display: "block", mb: 0.75 }}
      >
        Preview
      </Typography>
      <Stack spacing={1.5}>
        {segments.map((segment, index) => (
          <Fragment key={index}>
            {segment.type === "text" ? (
              <Prose text={segment.text} />
            ) : (
              <EmbedMarkerPreview
                projectId={projectId}
                match={segment.match}
                resolved={segment.resolved}
              />
            )}
          </Fragment>
        ))}
      </Stack>
    </Box>
  );
}

/** Whether a body has any artifact markers worth previewing. */
export const hasArtifactMarkers = (body: string): boolean =>
  findArtifactMarkers(body).length > 0;
