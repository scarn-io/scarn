"use client";

/** Building blocks of the step Details drawer's sections. */

import { Box, Button, Stack, Typography } from "@mui/material";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import { useState, type ReactNode } from "react";
import { SectionHeader } from "./thread-parts";
import { useTaskRunLogs } from "./use-task-run-logs";

/** One line in place of the logs themselves; **Open logs** shows them. */
export function LogsSummary({
  taskRunId,
  live,
  onOpen,
}: {
  taskRunId: string;
  live: boolean;
  onOpen: () => void;
}) {
  const logs = useTaskRunLogs(taskRunId, live);
  const warnings = logs.lines.filter((line) => line.level === "warn").length;
  const lineCount = logs.lines.length;
  return (
    <Stack direction="row" alignItems="center" spacing={1}>
      <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
        {logs.error ? (
          <Box component="span" sx={{ color: "error.main" }}>
            {logs.error}
          </Box>
        ) : logs.loading && lineCount === 0 ? (
          "Loading logs…"
        ) : (
          <>
            {lineCount} {lineCount === 1 ? "line" : "lines"}
            {warnings > 0 ? (
              <Box component="span" sx={{ color: "warning.main" }}>
                {" "}
                · {warnings} {warnings === 1 ? "warning" : "warnings"}
              </Box>
            ) : null}
          </>
        )}
      </Typography>
      <Button
        size="small"
        variant="outlined"
        endIcon={<OpenInFullIcon sx={{ fontSize: "16px !important" }} />}
        onClick={onOpen}
        sx={{ textTransform: "none" }}
      >
        Open logs
      </Button>
    </Stack>
  );
}

function SectionTitle({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "error";
}) {
  return (
    <Typography
      variant="caption"
      component="h3"
      sx={{
        display: "block",
        m: 0,
        mb: 1.25,
        color: tone === "error" ? "error.main" : "text.disabled",
        fontWeight: 600,
        letterSpacing: 0.3,
      }}
    >
      {children}
    </Typography>
  );
}

export function Section({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: "neutral" | "error";
  children: ReactNode;
}) {
  return (
    <Box component="section">
      <SectionTitle tone={tone}>{title}</SectionTitle>
      {children}
    </Box>
  );
}

/** Large evaluation snapshots start collapsed. */
export function CollapsedSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Box component="section">
      <SectionHeader open={open} onToggle={setOpen}>
        {title}
      </SectionHeader>
      {open ? <Box sx={{ mt: 1 }}>{children}</Box> : null}
    </Box>
  );
}

export const Muted = ({ children }: { children: ReactNode }) => (
  <Typography variant="body2" color="text.secondary">
    {children}
  </Typography>
);
