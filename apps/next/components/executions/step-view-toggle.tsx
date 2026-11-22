"use client";

import { Box, Stack } from "@mui/material";
import type { StepView } from "./execution-detail-params";

const VIEW_OPTIONS: { value: StepView; label: string }[] = [
  { value: "conversation", label: "Conversation" },
  { value: "logs", label: "Logs" },
];

/** The small segmented switch between the conversation and the raw logs. */
export function StepViewToggle({
  value,
  onChange,
}: {
  value: StepView;
  onChange: (view: StepView) => void;
}) {
  return (
    <Stack
      direction="row"
      role="tablist"
      aria-label="Step view"
      sx={{
        ml: 1.5,
        p: "2px",
        flexShrink: 0,
        borderRadius: 1.5,
        border: 1,
        borderColor: "divider",
      }}
    >
      {VIEW_OPTIONS.map((option) => {
        const selected = value === option.value;
        return (
          <Box
            key={option.value}
            component="button"
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => {
              onChange(option.value);
            }}
            sx={{
              all: "unset",
              cursor: "pointer",
              px: 1,
              py: 0.25,
              borderRadius: 1,
              fontSize: 12.5,
              color: selected ? "text.primary" : "text.secondary",
              backgroundColor: selected ? "action.selected" : "transparent",
              "&:hover": { color: "text.primary" },
              "&:focus-visible": {
                outline: 2,
                outlineColor: "primary.main",
              },
            }}
          >
            {option.label}
          </Box>
        );
      })}
    </Stack>
  );
}
