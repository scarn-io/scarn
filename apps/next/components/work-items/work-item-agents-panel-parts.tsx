"use client";

/** The pieces the agents panel's rows share: header, question, reply box. */

import { useState, type ReactNode } from "react";
import {
  Box,
  Button,
  Chip,
  Link as MuiLink,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import Link from "next/link";
import { parseApiError } from "@/app/_lib/api-error";
import { Prose } from "@/components/executions/prose";

export type Waiter = { userId: string; username: string | null };

export const waitingOnLabel = (waitingOn: readonly Waiter[]) =>
  waitingOn.map((person) => person.username ?? "someone").join(", ");

/** Runs one request at a time and keeps its error. */
export function useRowAction(onChanged: () => void) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (
    name: string,
    fallback: string,
    request: () => Promise<unknown>,
  ): Promise<boolean> => {
    setPending(name);
    setError(null);
    try {
      await request();
      onChanged();
      return true;
    } catch (actionError) {
      setError(parseApiError(actionError, fallback));
      return false;
    } finally {
      setPending(null);
    }
  };
  return { pending, error, run };
}

export function RowHeader({
  icon,
  name,
  href,
  status,
  waitingOnYou,
  waitingOn,
  actions,
}: {
  icon: ReactNode;
  name: string;
  href: string;
  status: ReactNode;
  waitingOnYou: boolean;
  waitingOn: readonly Waiter[];
  actions?: ReactNode;
}) {
  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      useFlexGap
      flexWrap="wrap"
    >
      {icon}
      <MuiLink
        component={Link}
        href={href}
        underline="hover"
        color="inherit"
        sx={{ fontWeight: 600, typography: "body2" }}
      >
        {name}
      </MuiLink>
      {status}
      {waitingOnYou ? (
        <Chip size="small" color="warning" label="You" />
      ) : waitingOn.length > 0 ? (
        <Chip
          size="small"
          variant="outlined"
          label={`Waiting on ${waitingOnLabel(waitingOn)}`}
        />
      ) : null}
      <Box sx={{ flex: 1 }} />
      {actions}
      <Button
        size="small"
        component={Link}
        href={href}
        endIcon={<OpenInNewIcon fontSize="small" />}
      >
        Open run
      </Button>
    </Stack>
  );
}

export function QuestionBlock({
  body,
  caption,
  highlighted,
}: {
  body: string;
  caption: string;
  highlighted: boolean;
}) {
  return (
    <Box
      data-testid="panel-question"
      sx={{
        p: 1.5,
        borderRadius: 1,
        border: 1,
        borderColor: highlighted ? "warning.main" : "divider",
        bgcolor: "action.hover",
      }}
    >
      <Prose text={body} />
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block", mt: 1 }}
      >
        {caption}
      </Typography>
    </Box>
  );
}

export function ReplyBox({
  placeholder,
  note,
  pending,
  canReply,
  onReply,
  children,
}: {
  placeholder: string;
  /** Shown above the box, e.g. who the row is waiting on. */
  note: string | null;
  pending: boolean;
  canReply: boolean;
  onReply: (body: string) => Promise<boolean>;
  /** The secondary actions, before Reply. */
  children?: ReactNode;
}) {
  const [draft, setDraft] = useState("");
  return (
    <Stack spacing={1}>
      {note ? (
        <Typography variant="caption" color="text.secondary">
          {note}
        </Typography>
      ) : null}
      {canReply ? (
        <TextField
          fullWidth
          multiline
          minRows={2}
          size="small"
          placeholder={placeholder}
          value={draft}
          disabled={pending}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          slotProps={{ htmlInput: { "aria-label": placeholder } }}
        />
      ) : null}
      <Stack direction="row" spacing={1} justifyContent="flex-end">
        {children}
        {canReply ? (
          <Button
            size="small"
            variant="contained"
            disabled={pending || draft.trim() === ""}
            onClick={() => {
              void onReply(draft.trim()).then((ok) => {
                if (ok) setDraft("");
              });
            }}
          >
            Reply
          </Button>
        ) : null}
      </Stack>
    </Stack>
  );
}
