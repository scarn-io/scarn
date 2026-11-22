"use client";

/**
 * How a run's status looks wherever it shows: the leading mark, the
 * outcome chip and the colour of the one-line status. Colours are theme
 * tokens so light and dark modes both read.
 */

import { Box, Typography } from "@mui/material";
import { alpha, type Theme } from "@mui/material/styles";
import type { ReactNode } from "react";
import type { ProjectRunStatus } from "@scarn/core/pipeline-executions/project-runs/contracts/project-runs-contracts";

export const RUN_STATUS_LABEL: Record<ProjectRunStatus, string> = {
  "needs-you": "Needs you",
  waiting: "Waiting",
  running: "Running",
  queued: "Queued",
  done: "Done",
  ended: "Ended",
  failed: "Failed",
  cancelled: "Cancelled",
};

const RUN_STATUS_GLYPH: Record<ProjectRunStatus, string> = {
  "needs-you": "●",
  waiting: "◔",
  running: "◐",
  queued: "○",
  done: "✓",
  ended: "■",
  failed: "✕",
  cancelled: "–",
};

/** The theme colour for `status`. */
export function runStatusColor(theme: Theme, status: ProjectRunStatus): string {
  const { palette } = theme;
  switch (status) {
    case "needs-you":
      return palette.info.main;
    case "running":
      return palette.text.primary;
    case "done":
      return palette.success.main;
    case "ended":
      return palette.warning.main;
    case "failed":
      return palette.error.main;
    case "waiting":
    case "queued":
    case "cancelled":
      return palette.text.disabled;
  }
}

/** Statuses that want attention: a filled mark and a coloured status line. */
export const isLoudRunStatus = (status: ProjectRunStatus): boolean =>
  status === "needs-you" || status === "failed" || status === "ended";

/** The row's leading marker: filled when it wants attention, outlined otherwise. */
export function StatusMark({ status }: { status: ProjectRunStatus }) {
  const loud = isLoudRunStatus(status);
  return (
    <Box
      role="img"
      aria-label={RUN_STATUS_LABEL[status]}
      title={RUN_STATUS_LABEL[status]}
      data-status={status}
      data-loud={loud ? "true" : "false"}
      sx={(theme) => {
        const color = runStatusColor(theme, status);
        return {
          mt: 0.25,
          width: 18,
          height: 18,
          flexShrink: 0,
          borderRadius: "50%",
          display: "grid",
          placeItems: "center",
          fontSize: 10,
          lineHeight: 1,
          color: loud ? theme.palette.background.paper : color,
          backgroundColor: loud ? color : "transparent",
          border: 1,
          borderColor: loud ? color : alpha(color, 0.45),
        };
      }}
    >
      <span aria-hidden>{RUN_STATUS_GLYPH[status]}</span>
    </Box>
  );
}

/** An `ended` run's error label or a `failed` run's error code, as a chip. */
export function OutcomeChip({
  status,
  outcome,
}: {
  status: ProjectRunStatus;
  outcome: string | null;
}) {
  if (!outcome) return null;
  return (
    <Box
      component="span"
      title={status === "ended" ? "How the run ended" : "What went wrong"}
      sx={(theme) => {
        const color = runStatusColor(theme, status);
        return {
          ml: 1,
          px: 0.75,
          py: 0.125,
          borderRadius: 1,
          fontSize: 11,
          fontWeight: 500,
          fontFamily: "var(--font-mono)",
          verticalAlign: "middle",
          color,
          border: 1,
          borderColor: alpha(color, 0.4),
          backgroundColor: alpha(color, 0.08),
        };
      }}
    >
      {outcome}
    </Box>
  );
}

/** One line on where the run is, coloured when it wants attention. */
export function StatusLine({
  status,
  children,
}: {
  status: ProjectRunStatus;
  children: ReactNode;
}) {
  return (
    <Typography
      variant="body2"
      noWrap
      component="div"
      sx={(theme) => ({
        mt: 0.5,
        color: isLoudRunStatus(status)
          ? runStatusColor(theme, status)
          : status === "running"
            ? theme.palette.text.secondary
            : theme.palette.text.disabled,
      })}
    >
      {children}
    </Typography>
  );
}

/** The run's status as a pill, for a run's own page header. */
export function StatusPill({ status }: { status: ProjectRunStatus }) {
  return (
    <Box
      component="span"
      data-status={status}
      sx={(theme) => {
        const color = runStatusColor(theme, status);
        return {
          display: "inline-flex",
          alignItems: "center",
          gap: 0.75,
          px: 1,
          py: 0.125,
          borderRadius: 99,
          fontSize: 12,
          fontWeight: 600,
          color,
          backgroundColor: alpha(color, 0.12),
          flexShrink: 0,
        };
      }}
    >
      <Box
        component="span"
        aria-hidden
        sx={(theme) => ({
          width: 6,
          height: 6,
          borderRadius: "50%",
          bgcolor: runStatusColor(theme, status),
        })}
      />
      {RUN_STATUS_LABEL[status]}
    </Box>
  );
}
