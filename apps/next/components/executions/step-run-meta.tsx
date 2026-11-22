"use client";

/** Small shared pieces for showing a visit's metadata. */

import { Box, Typography } from "@mui/material";
import type { ReactNode } from "react";

/** A caption label over its value, for a row of run metadata. */
export function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Box>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block" }}
      >
        {label}
      </Typography>
      <Typography variant="body2">{value}</Typography>
    </Box>
  );
}
