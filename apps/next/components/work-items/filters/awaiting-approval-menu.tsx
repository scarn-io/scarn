"use client";

import CheckIcon from "@mui/icons-material/Check";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Box,
  Button,
  Divider,
  List,
  ListItemButton,
  ListItemText,
  Popover,
  Typography,
} from "@mui/material";
import { useMenu } from "@/components/common/use-menu";

const PANE_WIDTH = 288;

/**
 * The `Awaiting approval ▾` control: a single toggle over whether the result
 * set is restricted to items with a pending or failed agent-drafted comment.
 *
 * One item in the popover is deliberate rather than a sign of an unfinished
 * menu — it reserves the strip position for a second, related item
 * (`Failed to post`, see `docs/plans/awaiting-approval-filter.md`'s Out of
 * scope) and keeps this control the same popover shape as every other one in
 * the strip. Re-selecting the active item clears it, matching
 * `UpdatedFilterMenu` and `FieldFilterMenu`.
 */
export function AwaitingApprovalFilterMenu({
  active,
  onChange,
}: {
  active: boolean;
  onChange: (active: boolean) => void;
}) {
  const menu = useMenu();

  const choose = () => {
    onChange(!active);
    menu.onClose();
  };

  return (
    <>
      <Button
        size="small"
        color="inherit"
        endIcon={<ExpandMoreIcon />}
        onClick={menu.onOpen}
        sx={{ flexShrink: 0, whiteSpace: "nowrap" }}
      >
        Awaiting approval
      </Button>
      <Popover
        open={menu.open}
        anchorEl={menu.anchorEl}
        onClose={menu.onClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
      >
        <Box sx={{ width: PANE_WIDTH }}>
          <Box sx={{ px: 2, pt: 1.5, pb: 1 }}>
            <Typography variant="subtitle2">Awaiting approval</Typography>
            <Typography variant="caption" color="text.secondary">
              Agent-drafted comments waiting for a human to approve or reject.
            </Typography>
          </Box>
          <Divider />
          <List dense sx={{ py: 0 }}>
            <ListItemButton selected={active} onClick={choose}>
              <ListItemText primary="Has a draft awaiting approval" />
              {active && <CheckIcon fontSize="small" color="primary" />}
            </ListItemButton>
          </List>
        </Box>
      </Popover>
    </>
  );
}
