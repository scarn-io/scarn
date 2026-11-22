"use client";

import type { ReactNode } from "react";
import { Box, Stack, Typography } from "@mui/material";
import InboxOutlinedIcon from "@mui/icons-material/InboxOutlined";

export type RecordListEmptyProps = {
  title: string;
  description?: ReactNode;
  /**
   * Optional leading icon. Defaults to a neutral inbox glyph. Pass `null` to
   * render no icon.
   */
  icon?: ReactNode;
  /** Optional call-to-action (e.g. a Button) rendered below the description. */
  action?: ReactNode;
};

export function RecordListEmpty({
  title,
  description,
  icon = <InboxOutlinedIcon fontSize="medium" />,
  action,
}: RecordListEmptyProps) {
  return (
    <Stack
      spacing={1}
      alignItems="center"
      sx={{ px: 2, py: 7, textAlign: "center" }}
    >
      {icon ? (
        <Box
          aria-hidden
          sx={{
            display: "flex",
            color: "text.disabled",
            "& .MuiSvgIcon-root": { fontSize: 28 },
          }}
        >
          {icon}
        </Box>
      ) : null}

      <Stack spacing={0.5} alignItems="center">
        <Typography sx={{ fontWeight: 600, fontSize: "1rem" }}>
          {title}
        </Typography>
        {description ? (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ maxWidth: 420 }}
          >
            {description}
          </Typography>
        ) : null}
      </Stack>

      {action ? <Box sx={{ pt: 1 }}>{action}</Box> : null}
    </Stack>
  );
}
