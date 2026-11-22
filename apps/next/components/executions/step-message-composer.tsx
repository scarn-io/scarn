"use client";

import {
  Alert,
  Box,
  IconButton,
  InputBase,
  Link as MuiLink,
  Stack,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import CloseIcon from "@mui/icons-material/Close";
import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { TASK_MESSAGE_BODY_MAX_LENGTH } from "@scarn/api/frontend-contracts";
import type { StepMessageGate } from "./execution-step-action-guards";
import { capitalize } from "./execution-status-icon";

/** "a", "a and b", "a, b and c". */
export function listJoin(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

/** "re-runs fix, then review and ship" for the steps a send re-runs. */
export function rerunLabel(rerunSteps: readonly string[]): string {
  const [self, ...after] = rerunSteps;
  if (self === undefined) return "re-runs this step";
  return after.length > 0
    ? `re-runs ${self}, then ${listJoin(after)}`
    : `re-runs ${self}`;
}

/**
 * The message box under a selected step: one rounded field with the send
 * button inside it, and an optional quote of agent text above the input.
 * Sending reruns this visit with the message attached, superseding
 * everything downstream of it; what it re-runs is spelled out once there's
 * text. The text is cleared only when the send succeeds. Cmd/Ctrl+Enter sends; Enter inserts a newline. Renders nothing
 * when the gate is hidden.
 */
export function StepMessageComposer({
  gate,
  rerunSteps,
  quote,
  onClearQuote,
  pending,
  error,
  onSend,
}: {
  gate: StepMessageGate;
  /** Display names of the steps a send re-runs: this step first, then every
   * step after it in position order. */
  rerunSteps: readonly string[];
  /** Agent text attached to the message; `null` when there's none. */
  quote: string | null;
  onClearQuote: () => void;
  pending: boolean;
  error: string;
  onSend: (body: string, quoteText: string | null) => Promise<boolean>;
}) {
  const [body, setBody] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (quote) inputRef.current?.focus();
  }, [quote]);

  if (gate.kind === "hidden") return null;

  const isReady = gate.kind === "ready";
  const hasText = body.trim().length > 0;
  const canSend = isReady && !pending && hasText;

  const send = async () => {
    if (!canSend) return;
    if (await onSend(body, quote)) setBody("");
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    if (!event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    void send();
  };

  const footer =
    gate.kind === "disabled" ? (
      <Typography variant="caption" color="text.secondary">
        {gate.reason}
        {gate.latestHref ? (
          <>
            {" · "}
            <MuiLink component={Link} href={gate.latestHref}>
              Go to the current visit
            </MuiLink>
          </>
        ) : null}
      </Typography>
    ) : hasText ? (
      <Typography variant="caption" color="text.secondary">
        {pending ? "Sending…" : capitalize(rerunLabel(rerunSteps))}
      </Typography>
    ) : null;

  return (
    <Box sx={{ pt: 1, pb: 1.5 }}>
      <Box
        sx={{
          borderRadius: 4,
          border: 1,
          borderColor: "divider",
          backgroundColor: (theme) => alpha(theme.palette.text.primary, 0.05),
          transition: "border-color 120ms",
          "&:focus-within": { borderColor: "text.disabled" },
          opacity: isReady ? 1 : 0.6,
        }}
      >
        {quote ? (
          <Stack
            direction="row"
            alignItems="flex-start"
            spacing={1}
            sx={{ px: 2, pt: 1.25 }}
          >
            <Typography
              variant="body2"
              data-testid="composer-quote"
              sx={{
                flex: 1,
                minWidth: 0,
                pl: 1.25,
                borderLeft: 2,
                borderColor: "text.disabled",
                color: "text.secondary",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                whiteSpace: "pre-wrap",
              }}
            >
              {quote}
            </Typography>
            <IconButton
              size="small"
              aria-label="Remove quote"
              onClick={onClearQuote}
              sx={{ mt: -0.5, mr: -1, color: "text.disabled" }}
            >
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Stack>
        ) : null}
        <Stack
          direction="row"
          alignItems="flex-end"
          sx={{ pl: 2, pr: 0.75, py: 0.75 }}
        >
          <InputBase
            inputRef={inputRef}
            multiline
            maxRows={10}
            fullWidth
            placeholder="Tell the agent what to change…"
            value={body}
            disabled={!isReady || pending}
            onChange={(event) => {
              setBody(event.target.value);
            }}
            onKeyDown={handleKeyDown}
            inputProps={{
              "aria-label": "Message to this step",
              maxLength: TASK_MESSAGE_BODY_MAX_LENGTH,
            }}
            sx={{ fontSize: 15, lineHeight: 1.6, py: 0.75 }}
          />
          <IconButton
            aria-label="Send & re-run from here"
            disabled={!canSend}
            onClick={() => {
              void send();
            }}
            size="small"
            sx={{
              ml: 1,
              mb: 0.25,
              width: 32,
              height: 32,
              flexShrink: 0,
              backgroundColor: "text.primary",
              color: "background.default",
              "&:hover": { backgroundColor: "text.secondary" },
              "&.Mui-disabled": {
                backgroundColor: (theme) =>
                  alpha(theme.palette.text.primary, 0.06),
                color: "text.disabled",
              },
            }}
          >
            <ArrowUpwardIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Stack>
      </Box>
      {error ? (
        <Alert severity="error" sx={{ mt: 1, py: 0 }}>
          {error}
        </Alert>
      ) : null}
      <Box sx={{ minHeight: 22, pt: 0.75, px: 2 }}>{footer}</Box>
    </Box>
  );
}
