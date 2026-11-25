import { Chip } from "@mui/material";
import { colors } from "@scarn/design-tokens";

/**
 * Semantic intents. Each renders as a GitHub-style "label": a muted/subtle
 * background with a readable foreground in the same hue, plus a hairline
 * border. This keeps status pills cohesive instead of using MUI's default
 * fully-saturated chip colors.
 */
type ChipColor =
  | "default"
  | "success"
  | "warning"
  | "error"
  | "info"
  | "primary"
  | "secondary";

const intentStyles: Record<
  ChipColor,
  { bg: string; fg: string; border: string }
> = {
  default: {
    bg: colors.borderMuted,
    fg: colors.textMuted,
    border: colors.border,
  },
  success: {
    bg: colors.successSubtle,
    fg: colors.successFg,
    border: colors.successMuted,
  },
  warning: {
    bg: colors.attentionSubtle,
    fg: colors.attentionFg,
    border: colors.attentionMuted,
  },
  error: {
    bg: colors.dangerSubtle,
    fg: colors.dangerFg,
    border: colors.dangerMuted,
  },
  info: {
    bg: colors.accentSubtle,
    fg: colors.accentFg,
    border: colors.accentMuted,
  },
  primary: {
    bg: colors.accentSubtle,
    fg: colors.accentFg,
    border: colors.accentMuted,
  },
  secondary: {
    bg: colors.doneSubtle,
    fg: colors.doneFg,
    border: colors.doneMuted,
  },
};

const colorByStatus: Record<string, ChipColor> = {
  advanced: "success",
  blocked: "error",
  cancelled: "default",
  completed: "success",
  current: "primary",
  error: "error",
  not_started: "default",
  route: "warning",
  pending: "default",
  queued: "info",
  running: "primary",
  timed_out: "error",
  timeout: "error",
  abandoned: "warning",
  unknown: "default",
  waiting_for_user_feedback: "warning",
  succeeded: "success",
  failed: "error",
  skipped: "default",
  failed_timeout: "error",
  needs_more_information: "warning",
  needs_triage: "warning",
  triaged_backlog: "info",
  in_progress: "primary",
  ops_resolution_needed: "warning",
  done: "success",
  lowest: "default",
  low: "info",
  medium: "warning",
  high: "warning",
  highest: "error",
  // Notification kinds
  feedback_request: "warning",
  status_update: "info",
  result_ready: "success",
  warning: "warning",
  // Notification priorities
  normal: "default",
  urgent: "error",
  // Notification delivery statuses
  delivered: "success",
  partially_delivered: "warning",
  suppressed: "default",
  // Notification delivery channel statuses (sent = delivered channel)
  sent: "success",
};

const humanize = (value: string) =>
  value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

export function StatusChip({
  value,
  label,
}: {
  value: string;
  label?: string;
}) {
  const intent = colorByStatus[value] ?? "default";
  const style = intentStyles[intent];

  return (
    <Chip
      label={label ?? humanize(value)}
      size="small"
      variant="filled"
      sx={{
        backgroundColor: style.bg,
        color: style.fg,
        border: `1px solid ${style.border}`,
        fontWeight: 600,
        "& .MuiChip-label": { paddingInline: "8px" },
      }}
    />
  );
}
