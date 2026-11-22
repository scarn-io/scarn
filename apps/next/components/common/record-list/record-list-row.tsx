"use client";

import { Box, Link as MuiLink, Stack } from "@mui/material";
import Link from "next/link";
import type { ReactNode } from "react";

export function RecordListRow({
  icon,
  primary,
  secondary,
  trailing,
  expanded,
  isFirst,
  href,
  onNavigate,
}: {
  /** Leading status icon slot. */
  icon?: ReactNode;
  /** Primary line (title/link). */
  primary: ReactNode;
  /** Secondary muted meta line. */
  secondary?: ReactNode;
  /** Trailing slot (chips/actions). */
  trailing?: ReactNode;
  /** Expandable content rendered below the row (e.g. details). */
  expanded?: ReactNode;
  /** When true, omit the top divider (first row in a list). */
  isFirst?: boolean;
  /**
   * When set, the entire row becomes clickable via a full-area overlay link
   * that navigates here. Interactive children (links, buttons) still work
   * because they sit above the overlay.
   */
  href?: string;
  /** Called when the overlay link is activated (e.g. to close a drawer). */
  onNavigate?: () => void;
}) {
  return (
    <Box
      sx={{
        position: "relative",
        borderTop: isFirst ? 0 : 1,
        borderColor: "divider",
        px: 2,
        py: 1.25,
        transition: "background-color 120ms ease",
        "&:hover": { backgroundColor: "action.hover" },
      }}
    >
      {href ? (
        <MuiLink
          component={Link}
          href={href}
          onClick={onNavigate}
          aria-label="Open"
          sx={{
            position: "absolute",
            inset: 0,
            zIndex: 0,
            // Invisible full-area click target.
            opacity: 0,
          }}
        />
      ) : null}
      <Stack
        direction="row"
        spacing={1.5}
        alignItems="flex-start"
        sx={
          href
            ? {
                position: "relative",
                // Let clicks on empty areas fall through to the overlay link,
                // while keeping interactive children (links/buttons) clickable.
                pointerEvents: "none",
                "& a, & button": { pointerEvents: "auto" },
              }
            : undefined
        }
      >
        {icon ? (
          <Box sx={{ pt: 0.25, flexShrink: 0 }}>{icon}</Box>
        ) : null}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box>{primary}</Box>
          {secondary ? <Box sx={{ mt: 0.25 }}>{secondary}</Box> : null}
        </Box>
        {trailing ? (
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{ flexShrink: 0 }}
          >
            {trailing}
          </Stack>
        ) : null}
      </Stack>
      {expanded}
    </Box>
  );
}
