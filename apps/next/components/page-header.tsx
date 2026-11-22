import { Box, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  /** Right-aligned slot for the page's primary action(s). */
  actions?: ReactNode;
}) {
  return (
    <Stack spacing={0.5} sx={{ mb: 3 }}>
      {eyebrow ? (
        <Typography
          variant="overline"
          color="text.secondary"
          sx={{ fontWeight: 600, fontSize: "0.75rem", letterSpacing: "0.08em" }}
        >
          {eyebrow}
        </Typography>
      ) : null}
      <Stack
        direction="row"
        spacing={2}
        alignItems="center"
        justifyContent="space-between"
      >
        <Typography
          variant="h1"
          sx={{ fontSize: "1.25rem", fontWeight: 600, lineHeight: 1.4 }}
        >
          {title}
        </Typography>
        {actions ? <Box sx={{ flexShrink: 0 }}>{actions}</Box> : null}
      </Stack>
      {description ? (
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 720 }}>
          {description}
        </Typography>
      ) : null}
    </Stack>
  );
}
