"use client";

import { Alert, Box, CircularProgress, Typography } from "@mui/material";
import type { ArtifactUrlState } from "./use-artifact-download-url";

export const EXPIRED_MESSAGE =
  "This file has expired and is no longer available.";
export const DELETED_MESSAGE = "This file was deleted.";

const MEDIA_SX = {
  display: "block",
  maxWidth: "100%",
  maxHeight: 480,
  borderRadius: 1,
  border: 1,
  borderColor: "divider",
  backgroundColor: "action.hover",
} as const;

/**
 * Inline `<video>`/`<img>` preview for an artifact, chosen by `kind`. Other
 * kinds have no preview and render nothing once the URL is ready.
 */
export function ArtifactMediaPreview({
  kind,
  name,
  state,
}: {
  kind: string;
  name: string;
  state: ArtifactUrlState;
}) {
  if (state.status === "loading") {
    return (
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 1 }}>
        <CircularProgress size={14} />
        <Typography variant="caption" color="text.secondary">
          Loading preview…
        </Typography>
      </Box>
    );
  }
  if (state.status === "expired") {
    return <Alert severity="info">{EXPIRED_MESSAGE}</Alert>;
  }
  if (state.status === "error") {
    return <Alert severity="warning">{state.message}</Alert>;
  }
  if (state.url === null) {
    return (
      <Typography variant="caption" color="text.secondary">
        Preview isn&apos;t available for this storage backend.
      </Typography>
    );
  }
  if (kind === "video") {
    return (
      <Box
        component="video"
        controls
        preload="metadata"
        src={state.url}
        aria-label={name}
        sx={MEDIA_SX}
      />
    );
  }
  if (kind === "image") {
    return <Box component="img" src={state.url} alt={name} sx={MEDIA_SX} />;
  }
  return null;
}
