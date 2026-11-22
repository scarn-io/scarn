"use client";

import {
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Tooltip,
} from "@mui/material";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import TravelExploreOutlinedIcon from "@mui/icons-material/TravelExploreOutlined";
import { basename } from "./format-artifact";
import type { ArtifactActions } from "./use-artifact-actions";
import type { ArtifactContract } from "@scarn/api/frontend-contracts";

const EXPIRED_TOOLTIP = "This artifact has expired and is no longer available.";

/** An artifact's expired bytes (`storeRef` nulled by the retention sweep). */
export const isArtifactExpired = (artifact: ArtifactContract): boolean =>
  artifact.storeRef === null;

function Pending() {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 40,
        height: 40,
      }}
    >
      <CircularProgress size={20} />
    </Box>
  );
}

/**
 * One artifact row's trailing controls: an "Expired" chip, a labeled
 * "View Playwright trace" button for traces (the flagship evidence, so it
 * reads as distinct from a plain download), and the download icon button.
 */
export function ArtifactActionButtons({
  artifact,
  actions,
}: {
  artifact: ArtifactContract;
  actions: ArtifactActions;
}) {
  const name = basename(artifact.relativeStorePath);
  const isExpired = isArtifactExpired(artifact);
  return (
    <>
      {isExpired ? (
        <Chip size="small" label="Expired" variant="outlined" />
      ) : null}
      {artifact.kind === "playwright-trace" ? (
        actions.viewingTraceIds.has(artifact.id) ? (
          <Pending />
        ) : (
          <Tooltip title={isExpired ? EXPIRED_TOOLTIP : ""}>
            <span>
              <Button
                variant="outlined"
                size="small"
                disabled={isExpired}
                startIcon={<TravelExploreOutlinedIcon fontSize="small" />}
                onClick={() => {
                  void actions.viewTrace(artifact);
                }}
                aria-label={`View Playwright trace ${name}`}
              >
                View Playwright trace
              </Button>
            </span>
          </Tooltip>
        )
      ) : null}
      {actions.downloadingIds.has(artifact.id) ? (
        <Pending />
      ) : (
        <Tooltip title={isExpired ? EXPIRED_TOOLTIP : "Download"}>
          <span>
            <IconButton
              size="small"
              disabled={isExpired}
              onClick={() => {
                void actions.download(artifact);
              }}
              aria-label={`Download ${name}`}
            >
              <FileDownloadOutlinedIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      )}
    </>
  );
}
