"use client";

import { useEffect } from "react";
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import { RecordList } from "@/components/common/record-list/record-list";
import { RecordListRow } from "@/components/common/record-list/record-list-row";
import { RecordListEmpty } from "@/components/common/record-list/record-list-empty";
import {
  ArtifactActionButtons,
  isArtifactExpired,
} from "./artifact-action-buttons";
import { basename, formatArtifactMeta } from "./format-artifact";
import { useArtifactActions } from "./use-artifact-actions";
import { useTaskRunArtifacts } from "./use-task-run-artifacts";
import { useTaskRunArtifactFailures } from "./use-task-run-artifact-failures";
import { humanizeArtifactFailureReason } from "./humanize-artifact-failure-reason";
import { formatBytes } from "./format-bytes";

/** "N artifact(s) failed to save for this step.", pluralized for `count`. */
function formatArtifactFailuresBannerText(count: number): string {
  return `${String(count)} artifact${count === 1 ? "" : "s"} failed to save for this step.`;
}

/**
 * The Artifacts section body. Lazily loads the task's artifacts on
 * mount — this component is only mounted when the host's Artifacts accordion is
 * expanded (the host unmounts collapsed section children), so mounting here is
 * the "expanded" signal and keeps the read off the hot path.
 *
 * Always renders the list (with an empty state for zero artifacts) per the
 * product decision to surface the section even when a step produced nothing.
 */
export function ExecutionArtifactsSection({
  taskRunId,
}: {
  taskRunId: string | null;
}) {
  const { artifacts, status, loading, error, load, getDownloadUrl } =
    useTaskRunArtifacts(taskRunId);
  const {
    artifactFailures,
    status: failuresStatus,
    loading: failuresLoading,
    load: loadFailures,
  } = useTaskRunArtifactFailures(taskRunId);
  const actions = useArtifactActions(getDownloadUrl);

  // Fires once on mount (i.e. on first expand); both hooks ignore repeat
  // calls while their own fetch is in flight, so re-mounts on expand/collapse
  // are safe.
  useEffect(() => {
    load();
    loadFailures();
  }, [load, loadFailures]);

  // Only the primary artifacts hook's error blocks the whole section (it
  // owns the list this section exists to show); a failures-list error is
  // treated as "no known failures" rather than hiding the successful
  // artifacts underneath it — see `use-task-run-artifact-failures.ts`.
  const isEmpty =
    status === "loaded" &&
    failuresStatus === "loaded" &&
    artifacts.length === 0 &&
    artifactFailures.length === 0;

  return (
    <RecordList
      title="Artifacts"
      count={artifacts.length + artifactFailures.length}
    >
      {loading || failuresLoading ? (
        <Stack alignItems="center" sx={{ px: 2, py: 4 }}>
          <CircularProgress size={24} />
        </Stack>
      ) : error ? (
        <Box sx={{ p: 2 }}>
          <Alert severity="error">{error}</Alert>
        </Box>
      ) : isEmpty ? (
        <RecordListEmpty
          title="No artifacts"
          description="This step didn't produce any downloadable artifacts."
        />
      ) : (
        <>
          {artifactFailures.length > 0 ? (
            <Box sx={{ p: 2 }}>
              <Alert severity="warning">
                {formatArtifactFailuresBannerText(artifactFailures.length)}
              </Alert>
            </Box>
          ) : null}
          {actions.actionError ? (
            <Box sx={{ p: 2 }}>
              <Alert severity="warning">{actions.actionError}</Alert>
            </Box>
          ) : null}
          {artifactFailures.map((failure, index) => (
            <RecordListRow
              key={failure.id}
              isFirst={index === 0}
              primary={
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 600,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {basename(failure.relativeStorePath)}
                </Typography>
              }
              secondary={
                <Typography variant="caption" color="text.secondary">
                  {formatBytes(failure.attemptedSizeBytes)}
                </Typography>
              }
              trailing={
                <Tooltip title={humanizeArtifactFailureReason(failure)}>
                  <Chip size="small" color="warning" label="Upload failed" />
                </Tooltip>
              }
            />
          ))}
          {artifacts.map((artifact, index) => {
            const isExpired = isArtifactExpired(artifact);
            return (
              <RecordListRow
                key={artifact.id}
                isFirst={index === 0 && artifactFailures.length === 0}
                primary={
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      opacity: isExpired ? 0.5 : 1,
                    }}
                  >
                    {basename(artifact.relativeStorePath)}
                  </Typography>
                }
                secondary={
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ opacity: isExpired ? 0.5 : 1 }}
                  >
                    {formatArtifactMeta(artifact)}
                  </Typography>
                }
                trailing={
                  <ArtifactActionButtons
                    artifact={artifact}
                    actions={actions}
                  />
                }
              />
            );
          })}
        </>
      )}
    </RecordList>
  );
}
