"use client";

import { useState } from "react";
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import type {
  ArtifactContract,
  ProjectArtifactBundleDetailContract,
} from "@scarn/api/frontend-contracts";
import { PageHeader } from "@/components/page-header";
import { basename } from "@/components/executions/format-artifact";
import { formatBytes } from "@/components/executions/format-bytes";
import { ArtifactSharePanel } from "./artifact-share-panel";
import {
  useArtifactBundlePreview,
  useArtifactBundleShare,
} from "./use-artifact-bundle";
import {
  triggerDownload,
  useArtifactDownloadUrl,
} from "./use-artifact-download-url";

export const BUNDLE_EXPIRED_MESSAGE =
  "This bundle has expired and is no longer available.";
export const BUNDLE_DELETED_MESSAGE = "This bundle was deleted.";
export const BUNDLE_PENDING_MESSAGE =
  "This bundle is still uploading. Reload the page once the step finishes.";
export const BUNDLE_FAILED_MESSAGE = "This bundle didn't finish uploading.";
export const PREVIEW_UNAVAILABLE_MESSAGE =
  "Preview isn't available on this server.";

/**
 * Sandbox for the preview frame. Never add `allow-same-origin`: bundles must
 * run in an opaque origin (ADR 0019 §3).
 */
export const BUNDLE_PREVIEW_SANDBOX =
  "allow-scripts allow-popups allow-forms allow-downloads";

type BundlePageProject = { name: string };

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

function MemberRow({
  member,
  rootPath,
}: {
  member: ArtifactContract;
  rootPath: string;
}) {
  const { state, fetchUrl } = useArtifactDownloadUrl(member, { auto: false });
  const [downloading, setDownloading] = useState(false);
  const prefix = `${rootPath.replace(/\/+$/, "")}/`;
  const path = member.relativeStorePath.startsWith(prefix)
    ? member.relativeStorePath.slice(prefix.length)
    : member.relativeStorePath;
  const name = basename(member.relativeStorePath);

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
    <Stack
      component="li"
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{ py: 0.5 }}
    >
      <Box
        component="span"
        sx={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.8125rem",
          flex: 1,
          minWidth: 0,
          wordBreak: "break-all",
        }}
      >
        {path}
      </Box>
      {state.status === "error" ? (
        <Typography variant="caption" color="error">
          {state.message}
        </Typography>
      ) : null}
      {member.sizeBytes !== null ? (
        <Typography variant="caption" color="text.secondary">
          {formatBytes(member.sizeBytes)}
        </Typography>
      ) : null}
      <Tooltip title="Download">
        <span>
          <IconButton
            size="small"
            aria-label={`Download ${path}`}
            disabled={downloading}
            onClick={handleDownload}
          >
            <DownloadIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Stack>
  );
}

function BundlePreview({
  projectId,
  bundleId,
  name,
}: {
  projectId: string;
  bundleId: string;
  name: string;
}) {
  const preview = useArtifactBundlePreview(projectId, bundleId, true);

  if (preview.status === "unavailable") {
    return <Alert severity="info">{PREVIEW_UNAVAILABLE_MESSAGE}</Alert>;
  }
  if (preview.status === "error") {
    return <Alert severity="error">{preview.message}</Alert>;
  }
  if (preview.status !== "ready") {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
        <CircularProgress size={24} aria-label="Loading preview" />
      </Box>
    );
  }
  return (
    <Box
      component="iframe"
      src={preview.url}
      title={`Preview of ${name}`}
      sandbox={BUNDLE_PREVIEW_SANDBOX}
      referrerPolicy="no-referrer"
      sx={{
        display: "block",
        width: "100%",
        height: "70vh",
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        backgroundColor: "background.paper",
      }}
    />
  );
}

function BundleShare({
  projectId,
  bundleId,
}: {
  projectId: string;
  bundleId: string;
}) {
  const { state, busy, actionError, share, revoke } = useArtifactBundleShare(
    projectId,
    bundleId,
  );
  if (state.status === "loading") return null;
  if (state.status === "error") {
    return <Alert severity="error">{state.message}</Alert>;
  }
  return (
    <ArtifactSharePanel
      share={state.share}
      busy={busy}
      error={actionError}
      onShare={share}
      onRevoke={revoke}
    />
  );
}

const statusChip = (
  bundle: ProjectArtifactBundleDetailContract,
): string | null => {
  if (bundle.deleted) return "Deleted";
  if (bundle.expired) return "Expired";
  if (bundle.status === "pending") return "Uploading";
  if (bundle.status === "failed") return "Failed";
  return null;
};

/**
 * The bundle page body: the bundle's name, file count, size and expiry, its
 * share link, a sandboxed preview served from the content origin, and its
 * files with a download button each. Pending, failed, expired and deleted
 * bundles say so instead of offering a preview.
 */
export function ArtifactBundlePageClient({
  bundle,
  project,
}: {
  bundle: ProjectArtifactBundleDetailContract;
  project: BundlePageProject;
}) {
  const viewable =
    bundle.status === "ready" && !bundle.expired && !bundle.deleted;
  const chip = statusChip(bundle);
  const fileCount = bundle.fileCount ?? bundle.members.length;

  return (
    <Stack spacing={2}>
      <PageHeader eyebrow={`${project.name} · Bundle`} title={bundle.name} />
      {bundle.deleted ? (
        <Alert severity="info">{BUNDLE_DELETED_MESSAGE}</Alert>
      ) : bundle.expired ? (
        <Alert severity="info">{BUNDLE_EXPIRED_MESSAGE}</Alert>
      ) : bundle.status === "pending" ? (
        <Alert severity="info">{BUNDLE_PENDING_MESSAGE}</Alert>
      ) : bundle.status === "failed" ? (
        <Alert severity="error">{BUNDLE_FAILED_MESSAGE}</Alert>
      ) : null}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1}>
          <MetaRow label="Bundle">
            <Box component="span" sx={{ fontFamily: "var(--font-mono)" }}>
              {bundle.rootPath}
            </Box>
            {chip ? (
              <Chip
                size="small"
                variant="outlined"
                label={chip}
                sx={{ ml: 1 }}
              />
            ) : null}
          </MetaRow>
          <MetaRow label="Files">
            {`${String(fileCount)} file${fileCount === 1 ? "" : "s"}`}
            {bundle.sizeBytes !== null
              ? ` · ${formatBytes(bundle.sizeBytes)}`
              : ""}
          </MetaRow>
          {bundle.fieldPath ? (
            <MetaRow label="Field">
              <Box component="span" sx={{ fontFamily: "var(--font-mono)" }}>
                {bundle.fieldPath}
              </Box>
            </MetaRow>
          ) : null}
          <MetaRow label="Saved">
            {new Date(bundle.createdAt).toLocaleString()}
          </MetaRow>
          <MetaRow label={bundle.expired ? "Expired" : "Expires"}>
            {new Date(bundle.expiresAt).toLocaleString()}
          </MetaRow>
        </Stack>
      </Paper>
      <BundleShare projectId={bundle.projectId} bundleId={bundle.id} />
      {viewable ? (
        <BundlePreview
          projectId={bundle.projectId}
          bundleId={bundle.id}
          name={bundle.name}
        />
      ) : null}
      {viewable && bundle.members.length > 0 ? (
        <Paper
          variant="outlined"
          sx={{ p: 2 }}
          component="section"
          aria-label="Bundle files"
        >
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Files
          </Typography>
          <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0 }}>
            {bundle.members.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                rootPath={bundle.rootPath}
              />
            ))}
          </Box>
        </Paper>
      ) : null}
    </Stack>
  );
}
