import AutorenewIcon from "@mui/icons-material/Autorenew";
import BlockIcon from "@mui/icons-material/Block";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import PanToolOutlinedIcon from "@mui/icons-material/PanToolOutlined";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import { Box, Tooltip, type SvgIconProps } from "@mui/material";
import type { ChildWorkItemStatus } from "@scarn/api/frontend-contracts";

/**
 * How each child work item status reads: its group label and the palette
 * colour its icon and progress bar segment share. The colours follow the
 * work item status ring: closed is green, a person's move is red, live work
 * is amber.
 */
export const CHILD_WORK_ITEM_STATUS_DISPLAY: Record<
  ChildWorkItemStatus,
  {
    label: string;
    color: string;
    Icon: (props: SvgIconProps) => React.ReactNode;
  }
> = {
  needs_person: {
    label: "Needs a person",
    color: "error.main",
    Icon: PanToolOutlinedIcon,
  },
  running: { label: "Running", color: "warning.main", Icon: AutorenewIcon },
  ready: { label: "Ready", color: "info.main", Icon: RadioButtonUncheckedIcon },
  blocked: { label: "Blocked", color: "text.disabled", Icon: BlockIcon },
  closed: { label: "Closed", color: "success.main", Icon: CheckCircleIcon },
};

/** A child work item's status as a small coloured icon with its label as tooltip. */
export function ChildWorkItemStatusIcon({
  status,
  size = 16,
}: {
  status: ChildWorkItemStatus;
  size?: number;
}) {
  const { label, color, Icon } = CHILD_WORK_ITEM_STATUS_DISPLAY[status];
  return (
    <Tooltip title={label}>
      <Box
        component="span"
        role="img"
        aria-label={label}
        data-status={status}
        sx={{ display: "inline-flex", flexShrink: 0, color }}
      >
        <Icon sx={{ fontSize: size }} />
      </Box>
    </Tooltip>
  );
}
