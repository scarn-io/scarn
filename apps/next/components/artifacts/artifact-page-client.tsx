"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import type { ProjectArtifactDetailContract } from "@scarn/api/frontend-contracts";
import { PageHeader } from "@/components/page-header";
import { projectSubPath } from "@/app/(protected)/projects/_lib/project-routing";
import {
  basename,
  formatArtifactMeta,
} from "@/components/executions/format-artifact";
import {
  ArtifactMediaPreview,
  DELETED_MESSAGE,
  EXPIRED_MESSAGE,
} from "./artifact-media-preview";
import {
  triggerDownload,
  useArtifactDownloadUrl,
} from "./use-artifact-download-url";

type ArtifactPageProject = {
  name: string;
  ownerUsername: string | null;
  slug: string;
};

const runHref = (
  project: ArtifactPageProject,
  artifact: ProjectArtifactDetailContract,
): string | null => {
  if (!project.ownerUsername || !artifact.pipelineRunId) return null;
  const path = projectSubPath(
    project.ownerUsername,
    project.slug,
    "runs",
    artifact.pipelineRunId,
  );
  return artifact.nodeKey
    ? `${path}?${new URLSearchParams({ step: artifact.nodeKey }).toString()}`
    : path;
};

function MetaRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Stack direction="row" spacing={2} alignItems="baseline">
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ width: 72, flexShrink: 0, fontWeight: 600 }}
      >
        {label}
      </Typography>
      <Typography variant="body2" component="div" sx={{ minWidth: 0 }}>
        {children}
      </Typography>
    </Stack>
  );
}

/**
 * The artifact page body: the file name, the run and step that produced it,
 * an inline preview for videos and images, and a download button. Expired and
 * deleted files say so instead of offering a preview.
 */
export function ArtifactPageClient({
  artifact,
  project,
}: {
  artifact: ProjectArtifactDetailContract;
  project: ArtifactPageProject;
}) {
  const isAvailable = artifact.status === "available";
  const hasPreview = artifact.kind === "video" || artifact.kind === "image";
  const { state, fetchUrl } = useArtifactDownloadUrl(artifact, {
    auto: isAvailable && hasPreview,
  });
  const [downloading, setDownloading] = useState(false);
  const name = basename(artifact.relativeStorePath);
  const href = runHref(project, artifact);
  const isExpired = artifact.status === "expired" || state.status === "expired";

  const handleDownload = () => {
    setDownloading(true);
    void fetchUrl()
      .then((url) => {
        if (url) triggerDownload(url, name);
      })
      .finally(() => {
        setDownloading(false);
      });
  };

  return (
    <Stack spacing={2}>
      <PageHeader
        eyebrow={`${project.name} · Artifact`}
        title={name}
        actions={
          isAvailable && !isExpired ? (
            <Button
              variant="contained"
              size="small"
              startIcon={<DownloadIcon />}
              onClick={handleDownload}
              disabled={downloading}
            >
              Download
            </Button>
          ) : null
        }
      />
      {artifact.status === "deleted" ? (
        <Alert severity="info">{DELETED_MESSAGE}</Alert>
      ) : isExpired ? (
        <Alert severity="info">{EXPIRED_MESSAGE}</Alert>
      ) : null}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1}>
          <MetaRow label="File">
            <Box component="span" sx={{ fontFamily: "var(--font-mono)" }}>
              {artifact.relativeStorePath}
            </Box>
            {artifact.status !== "available" ? (
              <Chip
                size="small"
                variant="outlined"
                label={artifact.status === "deleted" ? "Deleted" : "Expired"}
                sx={{ ml: 1 }}
              />
            ) : null}
          </MetaRow>
          {formatArtifactMeta(artifact) ? (
            <MetaRow label="Details">{formatArtifactMeta(artifact)}</MetaRow>
          ) : null}
          <MetaRow label="Run">
            {href ? (
              <Button
                component={Link}
                href={href}
                size="small"
                variant="text"
                endIcon={<OpenInNewIcon fontSize="inherit" />}
                sx={{ p: 0, minWidth: 0 }}
              >
                View run
              </Button>
            ) : (
              "Not part of a pipeline run"
            )}
          </MetaRow>
          {artifact.nodeKey ? (
            <MetaRow label="Step">
              <Box component="span" sx={{ fontFamily: "var(--font-mono)" }}>
                {artifact.nodeKey}
              </Box>
            </MetaRow>
          ) : null}
          <MetaRow label="Saved">
            {new Date(artifact.createdAt).toLocaleString()}
          </MetaRow>
        </Stack>
      </Paper>
      {isAvailable && !isExpired && (hasPreview || state.status === "error") ? (
        <ArtifactMediaPreview kind={artifact.kind} name={name} state={state} />
      ) : null}
    </Stack>
  );
}
