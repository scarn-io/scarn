"use client";

import { Box, Stack } from "@mui/material";

/** The Inbox tab's label, with its badge count when anything waits on the viewer. */
export function InboxTabLabel({ count }: { count: number }) {
  return (
    <Stack direction="row" spacing={0.75} alignItems="center" component="span">
      <span>Inbox</span>
      {count > 0 ? (
        <Box
          component="span"
          data-testid="inbox-badge"
          sx={{
            minWidth: 18,
            height: 18,
            px: 0.5,
            borderRadius: 9,
            bgcolor: "warning.main",
            color: "warning.contrastText",
            fontSize: 11,
            fontWeight: 700,
            lineHeight: "18px",
            textAlign: "center",
          }}
        >
          {count > 99 ? "99+" : count}
        </Box>
      ) : null}
    </Stack>
  );
}
