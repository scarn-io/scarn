"use client";

import { Box, Button, Stack, Typography } from "@mui/material";
import { useEffect } from "react";
import { captureException } from "@scarn/observability/analytics/browser";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    captureException(error, { digest: error.digest });
  }, [error]);

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        p: 4,
      }}
    >
      <Stack spacing={2} alignItems="center" maxWidth={480}>
        <Typography variant="h5" fontWeight={700}>
          Something went wrong
        </Typography>
        <Typography variant="body2" textAlign="center">
          We've been notified and will look into it. You can try again.
        </Typography>
        <Button variant="contained" onClick={reset}>
          Try again
        </Button>
      </Stack>
    </Box>
  );
}
