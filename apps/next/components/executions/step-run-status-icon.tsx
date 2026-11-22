import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CancelOutlinedIcon from "@mui/icons-material/CancelOutlined";
import ErrorIcon from "@mui/icons-material/Error";
import HistoryToggleOffIcon from "@mui/icons-material/HistoryToggleOff";
import HourglassEmptyIcon from "@mui/icons-material/HourglassEmpty";
import PanToolOutlinedIcon from "@mui/icons-material/PanToolOutlined";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutline";
import TimerOffOutlinedIcon from "@mui/icons-material/TimerOffOutlined";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import {
  Box,
  CircularProgress,
  Tooltip,
  type SvgIconProps,
} from "@mui/material";
import { VISIT_STATUS_LABELS, type VisitDisplayStatus } from "./visit-status";

const ICON_BOX_SIZE = 22;

const renderIcon = (
  Icon: (props: SvgIconProps) => React.ReactNode,
  color: SvgIconProps["color"],
) => <Icon color={color} sx={{ fontSize: 20 }} />;

const STATUS_ICONS: Record<VisitDisplayStatus, React.ReactNode> = {
  queued: renderIcon(HourglassEmptyIcon, "disabled"),
  running: <CircularProgress size={16} thickness={5} />,
  abandoned: renderIcon(WarningAmberIcon, "warning"),
  timeout: renderIcon(TimerOffOutlinedIcon, "error"),
  waiting: renderIcon(PanToolOutlinedIcon, "warning"),
  succeeded: renderIcon(CheckCircleIcon, "success"),
  failed: renderIcon(ErrorIcon, "error"),
  cancelled: renderIcon(CancelOutlinedIcon, "disabled"),
  superseded: renderIcon(HistoryToggleOffIcon, "disabled"),
};

/** `status: null` means the node has no visit yet: it hasn't been reached. */
const NOT_RUN_LABEL = "Not run";

export function StepRunStatusIcon({
  status,
}: {
  status: VisitDisplayStatus | null;
}) {
  const icon =
    status === null
      ? renderIcon(RemoveCircleOutlineIcon, "disabled")
      : STATUS_ICONS[status];

  return (
    <Tooltip title={getStepRunStatusLabel(status)}>
      <Box
        sx={{
          width: ICON_BOX_SIZE,
          height: ICON_BOX_SIZE,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {icon}
      </Box>
    </Tooltip>
  );
}

export function getStepRunStatusLabel(
  status: VisitDisplayStatus | null,
): string {
  return status === null ? NOT_RUN_LABEL : VISIT_STATUS_LABELS[status];
}
