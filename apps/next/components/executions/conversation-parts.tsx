"use client";

import { useState } from "react";
import {
  Box,
  CircularProgress,
  Collapse,
  Stack,
  Typography,
} from "@mui/material";
import BuildIcon from "@mui/icons-material/Build";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import PsychologyIcon from "@mui/icons-material/Psychology";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import type { Palette } from "@mui/material/styles";
import type {
  ConversationEvent,
  ConversationToolStatus,
} from "@scarn/api/frontend-contracts";
import { shimmerTextSx, usePrefersReducedMotion } from "./activity-shimmer";

/** Shimmering "Thinking…" label shown at the transcript tail while the agent works. */
export function ThinkingIndicator({ label = "Thinking…" }: { label?: string }) {
  const reducedMotion = usePrefersReducedMotion();
  return (
    <Typography
      data-activity="thinking"
      data-shimmer={reducedMotion ? undefined : "on"}
      variant="body2"
      sx={[
        { px: 1.5, fontWeight: 500, alignSelf: "flex-start" },
        reducedMotion
          ? { color: "text.secondary" }
          : shimmerTextSx((palette) => palette.text.disabled),
      ]}
    >
      {label}
    </Typography>
  );
}

/** Collapsible, muted block for an assistant message's reasoning text. */
export function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Box sx={{ mb: 1 }}>
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        onClick={() => {
          setOpen((value) => !value);
        }}
        sx={{ cursor: "pointer", color: "text.secondary", userSelect: "none" }}
      >
        {open ? (
          <ExpandMoreIcon fontSize="small" />
        ) : (
          <ChevronRightIcon fontSize="small" />
        )}
        <PsychologyIcon fontSize="small" />
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          Reasoning
        </Typography>
      </Stack>
      <Collapse in={open} unmountOnExit>
        <Typography
          component="div"
          variant="body2"
          sx={{
            mt: 0.5,
            pl: 2.5,
            color: "text.secondary",
            fontStyle: "italic",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {text}
        </Typography>
      </Collapse>
    </Box>
  );
}

const TOOL_STATUS_COLOR: Record<
  ConversationToolStatus,
  (palette: Palette) => string
> = {
  pending: (palette) => palette.text.disabled,
  running: (palette) => palette.info.main,
  completed: (palette) => palette.success.main,
  error: (palette) => palette.error.main,
};

export function isToolInProgress(status: ConversationToolStatus): boolean {
  return status === "pending" || status === "running";
}

function ToolStatusIcon({ status }: { status: ConversationToolStatus }) {
  switch (status) {
    case "running":
      return <CircularProgress size={14} />;
    case "completed":
      return <CheckCircleIcon fontSize="small" color="success" />;
    case "error":
      return <ErrorIcon fontSize="small" color="error" />;
    case "pending":
      return <BuildIcon fontSize="small" sx={{ color: "text.disabled" }} />;
  }
}

/**
 * Collapsible card for a single tool call: name, status, args, result. The
 * title row shimmers while the call is in progress and the step is `active`;
 * a call left unsettled by a finished step stays still.
 */
export function ToolCard({
  tool,
  active,
}: {
  tool: Extract<ConversationEvent, { kind: "tool" }>;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const inputText = tool.input === undefined ? "" : safeStringify(tool.input);
  const inProgress = active && isToolInProgress(tool.status);
  const shimmer = inProgress && !reducedMotion;
  const statusColor = TOOL_STATUS_COLOR[tool.status];

  return (
    <Box
      sx={{
        borderRadius: 1,
        border: 1,
        borderColor: "divider",
        backgroundColor: "background.paper",
        overflow: "hidden",
      }}
    >
      <Stack
        data-tool-row
        data-activity={inProgress ? "running" : undefined}
        data-shimmer={shimmer ? "on" : undefined}
        direction="row"
        spacing={1}
        alignItems="center"
        onClick={() => {
          setOpen((value) => !value);
        }}
        sx={{ cursor: "pointer", px: 1.5, py: 1, userSelect: "none" }}
      >
        {open ? (
          <ExpandMoreIcon fontSize="small" />
        ) : (
          <ChevronRightIcon fontSize="small" />
        )}
        <ToolStatusIcon status={tool.status} />
        <Typography
          variant="body2"
          sx={[
            { fontFamily: "var(--font-mono)", fontWeight: 600 },
            shimmer
              ? shimmerTextSx(statusColor)
              : { color: (theme) => statusColor(theme.palette) },
          ]}
        >
          {tool.tool}
        </Typography>
        {tool.title ? (
          <Typography
            variant="body2"
            sx={[
              {
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              },
              shimmer
                ? shimmerTextSx((palette) => palette.text.secondary)
                : { color: "text.secondary" },
            ]}
          >
            {tool.title}
          </Typography>
        ) : null}
      </Stack>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ px: 1.5, pb: 1.5 }}>
          {inputText ? <CodeBlock label="Input" value={inputText} /> : null}
          {tool.output ? (
            <CodeBlock label="Output" value={tool.output} />
          ) : null}
          {tool.error ? (
            <CodeBlock label="Error" value={tool.error} tone="error" />
          ) : null}
        </Box>
      </Collapse>
    </Box>
  );
}

function CodeBlock({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "error";
}) {
  return (
    <Box sx={{ mt: 1 }}>
      <Typography
        variant="caption"
        sx={{ color: "text.disabled", fontWeight: 600 }}
      >
        {label}
      </Typography>
      <Box
        component="pre"
        sx={{
          m: 0,
          mt: 0.5,
          p: 1,
          borderRadius: 1,
          backgroundColor: "action.hover",
          color: tone === "error" ? "error.main" : "text.primary",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {value}
      </Box>
    </Box>
  );
}

// eslint-disable-next-line local/no-unknown-parameter-type
function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
