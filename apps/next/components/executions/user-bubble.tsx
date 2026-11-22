"use client";

import { Box, Stack, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";

/** Your message to the step, right-aligned, with the text it quoted. */
export function UserBubble({
  body,
  quote,
}: {
  body: string;
  quote: string | null;
}) {
  return (
    <Stack alignItems="flex-end">
      <Box
        data-testid="user-bubble"
        sx={{
          maxWidth: "80%",
          px: 2,
          py: 1.25,
          borderRadius: 3,
          borderBottomRightRadius: 6,
          border: 1,
          backgroundColor: (theme) => alpha(theme.palette.primary.main, 0.12),
          borderColor: (theme) => alpha(theme.palette.primary.main, 0.3),
        }}
      >
        {quote ? (
          <Typography
            variant="body2"
            sx={{
              mb: 0.75,
              pl: 1.25,
              borderLeft: 2,
              borderColor: (theme) => alpha(theme.palette.primary.main, 0.55),
              color: "text.secondary",
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
            }}
          >
            {quote}
          </Typography>
        ) : null}
        <Typography
          sx={{
            fontSize: 15,
            lineHeight: 1.7,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {body}
        </Typography>
      </Box>
    </Stack>
  );
}
