"use client";

import { Box, Collapse, IconButton, Typography } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import type { ReactNode } from "react";

/**
 * The step rail on small screens: a collapsible panel at the top of main,
 * labelled with the current selection. Hidden at `md+` via CSS so it doesn't
 * depend on a JS media query (avoids a hydration flip on first paint).
 */
export function ExecutionMobileStepsPanel({
  open,
  onToggle,
  selectionLabel,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  selectionLabel: string;
  children: ReactNode;
}) {
  return (
    <Box
      sx={{
        display: { xs: "block", md: "none" },
        width: "100%",
        mb: 2,
        border: 1,
        borderColor: "divider",
        borderRadius: 2,
        backgroundColor: "background.paper",
        overflow: "hidden",
      }}
    >
      <Box
        component="button"
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        sx={{
          all: "unset",
          boxSizing: "border-box",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 1,
          width: "100%",
          px: 2,
          py: 1.5,
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography
            variant="overline"
            color="text.secondary"
            sx={{ display: "block", lineHeight: 1.2 }}
          >
            Steps
          </Typography>
          <Typography
            variant="body2"
            sx={{
              fontWeight: 600,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {selectionLabel}
          </Typography>
        </Box>
        <IconButton
          component="span"
          size="small"
          aria-hidden
          sx={{
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 150ms ease",
            pointerEvents: "none",
          }}
        >
          <ExpandMoreIcon />
        </IconButton>
      </Box>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ borderTop: 1, borderColor: "divider" }}>{children}</Box>
      </Collapse>
    </Box>
  );
}
