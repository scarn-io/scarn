"use client";

import ArrowBackIosNewIcon from "@mui/icons-material/ArrowBackIosNew";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Box,
  Button,
  Checkbox,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Popover,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { useMenu } from "@/components/common/use-menu";
import type { WorkItemFieldFilterOption } from "@/app/(protected)/projects/_lib/project-work-items";

const PANE_WIDTH = 300;
const LIST_MAX_HEIGHT = 320;

const matches = (candidate: string, search: string): boolean =>
  candidate.toLowerCase().includes(search.trim().toLowerCase());

const EmptyPaneNote = ({ children }: { children: string }) => (
  <Box sx={{ px: 2, py: 1.5 }}>
    <Typography variant="body2" color="text.secondary">
      {children}
    </Typography>
  </Box>
);

/**
 * The `Field ▾` control: a two-pane popover over the project's dynamic `fields`
 * keys. Pane one picks a key, pane two picks one of its values.
 *
 * The popover is the draft — a key chosen with no value yet is just an open
 * pane, so there is no half-built filter to model and nothing to discard. The
 * URL only ever sees a complete clause.
 */
export function FieldFilterMenu({
  options,
  activeValueByKey,
  onToggle,
}: {
  options: WorkItemFieldFilterOption[];
  activeValueByKey: Map<string, string>;
  onToggle: (key: string, value: string) => void;
}) {
  const menu = useMenu();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Nothing in this project carries filterable scalar fields, so the control
  // has nothing to offer. A disabled button would only advertise a dead end.
  if (options.length === 0) return null;

  const close = () => {
    menu.onClose();
    setOpenKey(null);
    setSearch("");
  };

  const showPane = (key: string | null) => {
    setOpenKey(key);
    setSearch("");
  };

  const openOption = options.find((option) => option.key === openKey);

  const searchField = (label: string) => (
    <TextField
      size="small"
      fullWidth
      autoFocus
      placeholder={label}
      value={search}
      onChange={(event) => {
        setSearch(event.target.value);
      }}
      slotProps={{ htmlInput: { "aria-label": label } }}
    />
  );

  const keyPane = () => {
    const visible = options.filter((option) => matches(option.key, search));
    return (
      <Box sx={{ width: PANE_WIDTH }}>
        <Box sx={{ p: 1 }}>{searchField("Find a field")}</Box>
        <Divider />
        <List
          dense
          sx={{ py: 0, maxHeight: LIST_MAX_HEIGHT, overflowY: "auto" }}
        >
          {visible.map((option) => (
            <ListItemButton
              key={option.key}
              onClick={() => {
                showPane(option.key);
              }}
            >
              <ListItemText
                primary={option.key}
                secondary={activeValueByKey.get(option.key)}
                slotProps={{ primary: { noWrap: true } }}
              />
              <ChevronRightIcon
                fontSize="small"
                sx={{ color: "text.disabled" }}
              />
            </ListItemButton>
          ))}
        </List>
        {visible.length === 0 && (
          <EmptyPaneNote>No fields match.</EmptyPaneNote>
        )}
      </Box>
    );
  };

  const valuePane = (option: WorkItemFieldFilterOption) => {
    const active = activeValueByKey.get(option.key);
    const visible = option.values.filter((value) => matches(value, search));
    return (
      <Box sx={{ width: PANE_WIDTH }}>
        <Stack direction="row" alignItems="center" spacing={0.5} sx={{ p: 1 }}>
          <IconButton
            size="small"
            aria-label="Back to fields"
            onClick={() => {
              showPane(null);
            }}
          >
            <ArrowBackIosNewIcon sx={{ fontSize: 14 }} />
          </IconButton>
          <Typography variant="subtitle2" noWrap sx={{ flexGrow: 1 }}>
            {option.key}
          </Typography>
        </Stack>
        <Box sx={{ px: 1, pb: 1 }}>{searchField("Find a value")}</Box>
        <Divider />
        <List
          dense
          sx={{ py: 0, maxHeight: LIST_MAX_HEIGHT, overflowY: "auto" }}
        >
          {visible.map((value) => (
            <ListItemButton
              key={value}
              onClick={() => {
                onToggle(option.key, value);
                close();
              }}
            >
              <Checkbox
                edge="start"
                size="small"
                tabIndex={-1}
                disableRipple
                checked={active === value}
                sx={{ py: 0, mr: 0.5 }}
              />
              <ListItemText
                primary={value}
                slotProps={{ primary: { noWrap: true } }}
              />
            </ListItemButton>
          ))}
        </List>
        {visible.length === 0 && (
          <EmptyPaneNote>No values match.</EmptyPaneNote>
        )}
        {option.truncated && (
          <>
            <Divider />
            <EmptyPaneNote>
              Only the most common values are listed.
            </EmptyPaneNote>
          </>
        )}
      </Box>
    );
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
        Field
      </Button>
      <Popover
        open={menu.open}
        anchorEl={menu.anchorEl}
        onClose={close}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
      >
        {openOption === undefined ? keyPane() : valuePane(openOption)}
      </Popover>
    </>
  );
}
