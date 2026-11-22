import type { ReactNode } from "react";
import { Box, Paper, Stack, Typography } from "@mui/material";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";

export function PipelineEmptyState({
  title,
  description,
  icon = <AccountTreeOutlinedIcon fontSize="medium" />,
  action,
}: {
  title: string;
  description: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 5 }}>
      <Stack spacing={1.5} alignItems="center" sx={{ textAlign: "center" }}>
        {icon ? (
          <Box
            aria-hidden
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 48,
              height: 48,
              borderRadius: "50%",
              bgcolor: "action.hover",
              color: "text.disabled",
            }}
          >
            {icon}
          </Box>
        ) : null}
        <Stack spacing={0.5} alignItems="center">
          <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
            {title}
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ maxWidth: 440 }}
          >
            {description}
          </Typography>
        </Stack>
        {action ? <Box sx={{ pt: 0.5 }}>{action}</Box> : null}
      </Stack>
    </Paper>
  );
}
