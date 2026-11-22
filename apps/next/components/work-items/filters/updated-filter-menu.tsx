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
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { useMenu } from "@/components/common/use-menu";
import type { TimeBound } from "@/components/work-items/filters/work-item-filter-model";

const PANE_WIDTH = 272;
const HOURS_PER_DAY = 24;

type Preset = {
  label: string;
  after?: TimeBound;
  before?: TimeBound;
};

const relative = (hours: number): TimeBound => ({ kind: "relative", hours });

/**
 * Both halves of a triage queue. Most date filters only offer "since", but a
 * queue has a cold end too and it gets worked just as deliberately as the hot
 * one — so staleness is a preset here, not something the user has to construct
 * out of a negation.
 */
const RECENT_PRESETS: Preset[] = [
  { label: "Last 24 hours", after: relative(HOURS_PER_DAY) },
  { label: "Last 7 days", after: relative(HOURS_PER_DAY * 7) },
  { label: "Last 30 days", after: relative(HOURS_PER_DAY * 30) },
];

const STALE_PRESETS: Preset[] = [
  { label: "Older than 30 days", before: relative(HOURS_PER_DAY * 30) },
  { label: "Older than 90 days", before: relative(HOURS_PER_DAY * 90) },
];

const sameBound = (left?: TimeBound, right?: TimeBound): boolean => {
  if (!left || !right) return left === right;
  if (left.kind === "relative" && right.kind === "relative") {
    return left.hours === right.hours;
  }
  if (left.kind === "absolute" && right.kind === "absolute") {
    return left.date === right.date;
  }
  return false;
};

const matchesPreset = (
  preset: Preset,
  after?: TimeBound,
  before?: TimeBound,
): boolean =>
  sameBound(preset.after, after) && sameBound(preset.before, before);

const toDateInputValue = (bound?: TimeBound): string =>
  bound?.kind === "absolute" ? bound.date : "";

const toAbsoluteBound = (value: string): TimeBound | undefined =>
  value.length > 0 ? { kind: "absolute", date: value } : undefined;

/**
 * The `Updated ▾` control: relative presets over the item's last change on its
 * source platform, with absolute dates behind one more click.
 *
 * Presets rather than a calendar because that is how triage actually thinks —
 * "what moved this week", "what has gone stale" — and because a real date
 * picker would mean a new dependency for the rarer case. The native
 * `type="date"` inputs cover that case without one.
 *
 * Choosing the preset that is already active clears it, matching the field
 * menu; the chip's own delete button is the other way out.
 */
export function UpdatedFilterMenu({
  after,
  before,
  onChange,
}: {
  after: TimeBound | undefined;
  before: TimeBound | undefined;
  onChange: (after?: TimeBound, before?: TimeBound) => void;
}) {
  const menu = useMenu();
  const [datesOpen, setDatesOpen] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const close = () => {
    menu.onClose();
    setDatesOpen(false);
  };

  const choosePreset = (preset: Preset) => {
    if (matchesPreset(preset, after, before)) {
      onChange(undefined, undefined);
    } else {
      onChange(preset.after, preset.before);
    }
    close();
  };

  const openDates = () => {
    setFromDate(toDateInputValue(after));
    setToDate(toDateInputValue(before));
    setDatesOpen(true);
  };

  const applyDates = () => {
    onChange(toAbsoluteBound(fromDate), toAbsoluteBound(toDate));
    close();
  };

  const presetItem = (preset: Preset) => {
    const active = matchesPreset(preset, after, before);
    return (
      <ListItemButton
        key={preset.label}
        selected={active}
        onClick={() => {
          choosePreset(preset);
        }}
      >
        <ListItemText primary={preset.label} />
        {active && <CheckIcon fontSize="small" color="primary" />}
      </ListItemButton>
    );
  };

  // Named explicitly because the product carries two clocks — "Source Updated"
  // and "Synced" — and a control labelled only "Updated" does not say which.
  const subhead = (
    <Box sx={{ px: 2, pt: 1.5, pb: 1 }}>
      <Typography variant="subtitle2">Source updated</Typography>
      <Typography variant="caption" color="text.secondary">
        When the item last changed on its source platform.
      </Typography>
    </Box>
  );

  const datePane = (
    <Box sx={{ px: 2, pb: 2, pt: 1 }}>
      <Stack spacing={1.5}>
        <TextField
          size="small"
          type="date"
          label="On or after"
          value={fromDate}
          onChange={(event) => {
            setFromDate(event.target.value);
          }}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <TextField
          size="small"
          type="date"
          label="Before"
          value={toDate}
          onChange={(event) => {
            setToDate(event.target.value);
          }}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <Button size="small" variant="contained" onClick={applyDates}>
          Apply
        </Button>
      </Stack>
    </Box>
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
        Updated
      </Button>
      <Popover
        open={menu.open}
        anchorEl={menu.anchorEl}
        onClose={close}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
      >
        <Box sx={{ width: PANE_WIDTH }}>
          {subhead}
          <Divider />
          <List dense sx={{ py: 0 }}>
            {RECENT_PRESETS.map(presetItem)}
          </List>
          <Divider />
          <List dense sx={{ py: 0 }}>
            {STALE_PRESETS.map(presetItem)}
          </List>
          <Divider />
          {datesOpen ? (
            datePane
          ) : (
            <List dense sx={{ py: 0 }}>
              <ListItemButton onClick={openDates}>
                <ListItemText primary="Between dates…" />
              </ListItemButton>
            </List>
          )}
        </Box>
      </Popover>
    </>
  );
}
