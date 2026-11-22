"use client";

import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Box,
  Button,
  Checkbox,
  Divider,
  List,
  ListItemButton,
  ListItemText,
  Popover,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { useMenu } from "@/components/common/use-menu";

const PANE_WIDTH = 288;
const LIST_MAX_HEIGHT = 320;

/**
 * The active labels first in their own order, then every other label the
 * project offers. An active label the project no longer carries still shows,
 * so it can be unticked.
 */
const labelChoices = (
  options: readonly string[],
  active: readonly string[],
) => [...active, ...options.filter((option) => !active.includes(option))];

/**
 * The `Labels ▾` control: a checklist over the project's labels. Unlike the
 * single-choice menus it stays open on a pick, because labels combine — each
 * ticked label narrows the list further.
 */
export function LabelFilterMenu({
  options,
  active,
  onToggle,
}: {
  options: readonly string[];
  active: readonly string[];
  onToggle: (label: string) => void;
}) {
  const menu = useMenu();
  const [search, setSearch] = useState("");

  // No item in the project carries a label and none is filtered on, so there
  // is nothing to pick.
  if (options.length === 0 && active.length === 0) return null;

  const close = () => {
    menu.onClose();
    setSearch("");
  };

  const needle = search.trim().toLowerCase();
  const visible = labelChoices(options, active).filter((label) =>
    label.toLowerCase().includes(needle),
  );

  return (
    <>
      <Button
        size="small"
        color="inherit"
        endIcon={<ExpandMoreIcon />}
        onClick={menu.onOpen}
        sx={{ flexShrink: 0, whiteSpace: "nowrap" }}
      >
        Labels
      </Button>
      <Popover
        open={menu.open}
        anchorEl={menu.anchorEl}
        onClose={close}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
      >
        <Box sx={{ width: PANE_WIDTH }}>
          <Box sx={{ px: 2, pt: 1.5, pb: 1 }}>
            <Typography variant="subtitle2">Labels</Typography>
            <Typography variant="caption" color="text.secondary">
              Items carrying every ticked label.
            </Typography>
          </Box>
          <Box sx={{ px: 1, pb: 1 }}>
            <TextField
              size="small"
              fullWidth
              autoFocus
              placeholder="Find a label"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
              slotProps={{ htmlInput: { "aria-label": "Find a label" } }}
            />
          </Box>
          <Divider />
          <List
            dense
            sx={{ py: 0, maxHeight: LIST_MAX_HEIGHT, overflowY: "auto" }}
          >
            {visible.map((label) => (
              <ListItemButton
                key={label}
                onClick={() => {
                  onToggle(label);
                }}
              >
                <Checkbox
                  edge="start"
                  size="small"
                  tabIndex={-1}
                  disableRipple
                  checked={active.includes(label)}
                  sx={{ py: 0, mr: 0.5 }}
                />
                <ListItemText
                  primary={label}
                  slotProps={{ primary: { noWrap: true } }}
                />
              </ListItemButton>
            ))}
          </List>
          {visible.length === 0 && (
            <Box sx={{ px: 2, py: 1.5 }}>
              <Typography variant="body2" color="text.secondary">
                No labels match.
              </Typography>
            </Box>
          )}
        </Box>
      </Popover>
    </>
  );
}
