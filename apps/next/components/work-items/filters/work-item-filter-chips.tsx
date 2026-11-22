"use client";

import CancelIcon from "@mui/icons-material/Cancel";
import SearchIcon from "@mui/icons-material/Search";
import { Box, Button, Chip, IconButton, Stack } from "@mui/material";
import { colors } from "@scarn/design-tokens";
import { useState, type KeyboardEvent } from "react";
import {
  describeFilter,
  type WorkItemFilter,
} from "@/components/work-items/filters/work-item-filter-model";

/**
 * The chip line: every structured clause as a removable chip, sharing one
 * outlined box with the free-text input.
 *
 * The free-text clause is the input's own value rather than a chip — it is the
 * only clause the user edits character by character, and giving it back to the
 * box keeps "type, press Enter, refine, press Enter again" working the way it
 * does today. Every other clause is a chip.
 *
 * Purely presentational: it owns the uncommitted keystrokes and nothing else.
 * The URL is written by the caller.
 */
export function WorkItemFilterChips({
  filters,
  memberName,
  searchText,
  onCommitText,
  onRemoveFilter,
  onClearFilters,
}: {
  filters: WorkItemFilter[];
  memberName?: (userId: string) => string | undefined;
  searchText: string;
  onCommitText: (value: string) => void;
  onRemoveFilter: (filter: WorkItemFilter) => void;
  onClearFilters: () => void;
}) {
  const [draft, setDraft] = useState(searchText);
  const [committedText, setCommittedText] = useState(searchText);

  // The URL is the source of truth, so a change that came from outside this
  // component (Clear filters, the back button, a shared link) has to land in
  // the box. Comparing against the last URL value seen — rather than syncing in
  // an effect — is what stops the box from overwriting the keystroke that is
  // still in flight towards the URL.
  if (searchText !== committedText) {
    setCommittedText(searchText);
    setDraft(searchText);
  }

  const chips = filters.filter((filter) => filter.kind !== "text");
  const lastChip = chips.at(-1);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onCommitText(draft);
      return;
    }
    if (event.key === "Backspace" && draft.length === 0 && lastChip) {
      event.preventDefault();
      onRemoveFilter(lastChip);
    }
  };

  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          flexGrow: 1,
          gap: 0.75,
          px: 1.25,
          minHeight: 40,
          border: 1,
          borderColor: "divider",
          borderRadius: 1.5,
          backgroundColor: "background.paper",
          // Scrolls rather than wraps: a second row of chips would push the
          // control strip down the page, which is the thing this bar exists to
          // stop happening.
          overflowX: "auto",
          "&:focus-within": { borderColor: colors.accentFg },
        }}
      >
        <SearchIcon
          fontSize="small"
          sx={{ color: "text.disabled", flexShrink: 0 }}
        />

        {chips.map((filter) => {
          const { label, tone } = describeFilter(filter, memberName);
          return (
            <Chip
              key={label}
              label={label}
              size="small"
              variant="outlined"
              sx={
                tone === "project"
                  ? { borderColor: colors.accent, color: colors.accent }
                  : undefined
              }
              onDelete={() => {
                onRemoveFilter(filter);
              }}
              deleteIcon={
                <IconButton
                  size="small"
                  aria-label={`Remove ${label} filter`}
                  sx={{
                    p: 0,
                    color: "inherit",
                    "& .MuiSvgIcon-root": { fontSize: 16 },
                  }}
                >
                  <CancelIcon />
                </IconButton>
              }
            />
          );
        })}

        <Box
          component="input"
          type="text"
          aria-label="Search work items"
          placeholder="Search work items"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          sx={{
            flex: "1 1 140px",
            minWidth: 140,
            alignSelf: "stretch",
            border: "none",
            outline: "none",
            background: "transparent",
            color: "text.primary",
            fontFamily: "inherit",
            fontSize: "0.875rem",
            "&::placeholder": { color: "text.disabled", opacity: 1 },
          }}
        />
      </Box>

      {filters.length > 0 && (
        <Button
          size="small"
          variant="text"
          onClick={onClearFilters}
          sx={{ flexShrink: 0 }}
        >
          Clear filters
        </Button>
      )}
    </Stack>
  );
}
