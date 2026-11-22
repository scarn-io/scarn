"use client";

import { Box, Chip, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";

export function RecordList({
  title,
  count,
  headerAction,
  children,
}: {
  title: string;
  count?: number;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Box
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 2,
        overflow: "hidden",
        backgroundColor: "background.paper",
      }}
    >
      <Stack
        direction="row"
        spacing={1.5}
        alignItems="center"
        justifyContent="space-between"
        sx={{
          px: 2,
          py: 1.25,
          backgroundColor: "action.hover",
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            {title}
          </Typography>
          {typeof count === "number" ? (
            <Chip label={count} size="small" />
          ) : null}
        </Stack>
        {headerAction ? (
          <Box sx={{ flexShrink: 0 }}>{headerAction}</Box>
        ) : null}
      </Stack>
      <Box>{children}</Box>
    </Box>
  );
}
