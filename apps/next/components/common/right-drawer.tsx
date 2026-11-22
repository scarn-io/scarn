"use client";

import { Box, Drawer, IconButton, Stack, Typography } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import type { ReactNode } from "react";
import { useResizableWidth } from "./use-resizable-width";

const DEFAULT_WIDTH = 640;
const MIN_WIDTH = 400;

/** The drag handle on a right-anchored drawer's left edge, from `from` up. */
export function DrawerResizeHandle({
  onPointerDown,
  from = "sm",
}: {
  onPointerDown: (event: React.PointerEvent) => void;
  from?: "sm" | "md";
}) {
  return (
    <Box
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize drawer"
      onPointerDown={onPointerDown}
      sx={{
        display: { xs: "none", [from]: "block" },
        position: "absolute",
        top: 0,
        left: 0,
        height: "100%",
        width: "6px",
        cursor: "col-resize",
        zIndex: 1,
        "&:hover": { backgroundColor: "action.hover" },
        "&:active": { backgroundColor: "action.selected" },
      }}
    />
  );
}

/**
 * A modal right-anchored slide-over. Opens wide (~640px) on desktop and is
 * resizable via a drag handle on its left edge; full-width on mobile with a
 * dimmed backdrop. Header shows a title, an optional action slot, and a close
 * button. Body scrolls independently.
 */
export function RightDrawer({
  open,
  onClose,
  title,
  headerAction,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  const { width, startDragging } = useResizableWidth({
    initialWidth: DEFAULT_WIDTH,
    minWidth: MIN_WIDTH,
  });

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: {
            width: { xs: "100%", sm: width },
            maxWidth: "100vw",
            display: "flex",
            flexDirection: "column",
          },
        },
      }}
    >
      <DrawerResizeHandle onPointerDown={startDragging} />
      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        justifyContent="space-between"
        sx={{
          px: 2,
          py: 1.25,
          borderBottom: 1,
          borderColor: "divider",
          flexShrink: 0,
        }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          {headerAction}
          <IconButton size="small" onClick={onClose} aria-label="Close">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: 2 }}>
        {children}
      </Box>
    </Drawer>
  );
}
