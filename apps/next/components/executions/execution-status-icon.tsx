import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CancelOutlinedIcon from "@mui/icons-material/CancelOutlined";
import ErrorIcon from "@mui/icons-material/Error";
import HourglassEmptyIcon from "@mui/icons-material/HourglassEmpty";
import PanToolOutlinedIcon from "@mui/icons-material/PanToolOutlined";
import {
  Box,
  CircularProgress,
  Tooltip,
  type SvgIconProps,
} from "@mui/material";
import type { PipelineExecutionContract } from "@scarn/api/frontend-contracts";

type Status = PipelineExecutionContract["status"];

const ICON_BOX_SIZE = 24;

const renderIcon = (
  Icon: (props: SvgIconProps) => React.ReactNode,
  color: SvgIconProps["color"],
) => <Icon color={color} sx={{ fontSize: 22 }} />;

const STATUS_ICONS: Record<Status, React.ReactNode> = {
  succeeded: renderIcon(CheckCircleIcon, "success"),
  failed: renderIcon(ErrorIcon, "error"),
  cancelled: renderIcon(CancelOutlinedIcon, "disabled"),
  queued: renderIcon(HourglassEmptyIcon, "disabled"),
  running: <CircularProgress size={18} thickness={5} />,
  waiting: renderIcon(PanToolOutlinedIcon, "warning"),
};

const STATUS_LABELS: Record<Status, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  queued: "Queued",
  running: "Running",
  waiting: "Waiting",
};

/** Human-readable label for an execution status, e.g. "Succeeded". */
export function getExecutionStatusLabel(status: Status): string {
  return STATUS_LABELS[status];
}

/**
 * Maps an execution status to a MUI palette text color, used to color status
 * text consistently with the status icon.
 */
export function getExecutionStatusColor(
  status: Status,
): "success.main" | "error.main" | "warning.main" | "text.secondary" {
  switch (status) {
    case "succeeded":
      return "success.main";
    case "failed":
      return "error.main";
    case "waiting":
      return "warning.main";
    case "queued":
    case "running":
    case "cancelled":
      return "text.secondary";
  }
}

export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function ExecutionStatusIcon({ status }: { status: Status }) {
  return (
    <Tooltip title={STATUS_LABELS[status]}>
      <Box
        sx={{
          width: ICON_BOX_SIZE,
          height: ICON_BOX_SIZE,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {STATUS_ICONS[status]}
      </Box>
    </Tooltip>
  );
}
