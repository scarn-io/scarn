"use client";

import { Box, Typography } from "@mui/material";
import type { AnyJsonValue } from "@scarn/api/frontend-contracts";

const renderValue = (value: AnyJsonValue): string => {
  if (value === null) {
    return "—";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
};

export function JsonBlock({ value }: { value: AnyJsonValue | null }) {
  if (value === null) {
    return (
      <Typography variant="body2" color="text.secondary">
        —
      </Typography>
    );
  }
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 1.5,
        borderRadius: 1.5,
        backgroundColor: "background.default",
        border: 1,
        borderColor: "divider",
        fontSize: 12.5,
        lineHeight: 1.55,
        overflow: "auto",
        maxHeight: 360,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {renderValue(value)}
    </Box>
  );
}
