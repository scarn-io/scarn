"use client";

/**
 * A finished run's artifacts, shown inline at the end of its conversation so
 * the evidence sits where the agent's work concludes rather than only in the
 * Details drawer. Renders nothing until the list loads, and nothing at all
 * for a run that produced no artifacts and had no upload failures.
 */

import { useEffect } from "react";
import { Box, Stack, Tooltip, Typography } from "@mui/material";
import AttachFileIcon from "@mui/icons-material/AttachFile";
import InsertDriveFileOutlinedIcon from "@mui/icons-material/InsertDriveFileOutlined";
import TravelExploreOutlinedIcon from "@mui/icons-material/TravelExploreOutlined";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import {
  ArtifactActionButtons,
  isArtifactExpired,
} from "./artifact-action-buttons";
import { basename, formatArtifactMeta } from "./format-artifact";
import { formatBytes } from "./format-bytes";
import { humanizeArtifactFailureReason } from "./humanize-artifact-failure-reason";
import { useArtifactActions } from "./use-artifact-actions";
import { useTaskRunArtifactFailures } from "./use-task-run-artifact-failures";
import { useTaskRunArtifacts } from "./use-task-run-artifacts";
import type { ArtifactContract } from "@scarn/api/frontend-contracts";

/** Playwright traces first, then everything else in upload order. */
const tracesFirst = (artifacts: readonly ArtifactContract[]) => [
  ...artifacts.filter((artifact) => artifact.kind === "playwright-trace"),
  ...artifacts.filter((artifact) => artifact.kind !== "playwright-trace"),
];

export function RunArtifactsCard({ taskRunId }: { taskRunId: string }) {
  const { artifacts, status, error, load, getDownloadUrl } =
    useTaskRunArtifacts(taskRunId);
  const { artifactFailures, load: loadFailures } =
    useTaskRunArtifactFailures(taskRunId);
  const actions = useArtifactActions(getDownloadUrl);

  useEffect(() => {
    load();
    loadFailures();
  }, [load, loadFailures]);

  if (status === "idle" || status === "loading") return null;
  if (status === "error") {
    return (
      <Typography variant="body2" color="error.main">
        Couldn&apos;t load artifacts: {error}
      </Typography>
    );
  }
  const count = artifacts.length + artifactFailures.length;
  if (count === 0) return null;

  return (
    <Box
      component="section"
      aria-label="Run artifacts"
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 1.5,
        overflow: "hidden",
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{
          px: 1.5,
          minHeight: 40,
          backgroundColor: "action.hover",
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <AttachFileIcon sx={{ fontSize: 18, color: "text.secondary" }} />
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          Artifacts
        </Typography>
        <Typography variant="body2" color="text.secondary">
          · {count} {count === 1 ? "file" : "files"}
        </Typography>
      </Stack>
      {actions.actionError || error ? (
        <Typography
          variant="body2"
          color="warning.main"
          sx={{ px: 1.5, pt: 1 }}
        >
          {actions.actionError || error}
        </Typography>
      ) : null}
      <Stack divider={<Box sx={{ borderTop: 1, borderColor: "divider" }} />}>
        {tracesFirst(artifacts).map((artifact) => {
          const isTrace = artifact.kind === "playwright-trace";
          const Icon = isTrace
            ? TravelExploreOutlinedIcon
            : InsertDriveFileOutlinedIcon;
          return (
            <ArtifactRow
              key={artifact.id}
              icon={
                <Icon
                  sx={{
                    fontSize: 18,
                    color: isTrace ? "primary.main" : "text.secondary",
                  }}
                />
              }
              name={basename(artifact.relativeStorePath)}
              meta={formatArtifactMeta(artifact)}
              dimmed={isArtifactExpired(artifact)}
              trailing={
                <ArtifactActionButtons artifact={artifact} actions={actions} />
              }
            />
          );
        })}
        {artifactFailures.map((failure) => (
          <ArtifactRow
            key={failure.id}
            icon={
              <WarningAmberIcon sx={{ fontSize: 18, color: "warning.main" }} />
            }
            name={basename(failure.relativeStorePath)}
            meta={formatBytes(failure.attemptedSizeBytes)}
            trailing={
              <Tooltip title={humanizeArtifactFailureReason(failure)}>
                <Typography variant="caption" color="warning.main">
                  Upload failed
                </Typography>
              </Tooltip>
            }
          />
        ))}
      </Stack>
    </Box>
  );
}

function ArtifactRow({
  icon,
  name,
  meta,
  trailing,
  dimmed = false,
}: {
  icon: React.ReactNode;
  name: string;
  meta: string;
  trailing: React.ReactNode;
  dimmed?: boolean;
}) {
  return (
    <Stack
      direction="row"
      alignItems="center"
      spacing={1.25}
      sx={{ px: 1.5, py: 0.75, minHeight: 48 }}
    >
      <Box sx={{ display: "flex", flexShrink: 0, opacity: dimmed ? 0.5 : 1 }}>
        {icon}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0, opacity: dimmed ? 0.5 : 1 }}>
        <Typography
          variant="body2"
          sx={{
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </Typography>
        {meta ? (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block" }}
          >
            {meta}
          </Typography>
        ) : null}
      </Box>
      <Stack
        direction="row"
        alignItems="center"
        spacing={0.5}
        sx={{ flexShrink: 0 }}
      >
        {trailing}
      </Stack>
    </Stack>
  );
}
