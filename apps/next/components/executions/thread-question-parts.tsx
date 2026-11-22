"use client";

/**
 * The parts of a run section around a continuation: the messages that
 * started the run, and whether it restored the agent's session.
 */

import { Stack, Typography } from "@mui/material";
import { sessionNote, type StepThreadRun } from "./step-thread-model";
import { UserBubble } from "./user-bubble";

/** The messages that started a run. */
export function RunMessages({ run }: { run: StepThreadRun }) {
  if (run.messages.length === 0) return null;
  return (
    <Stack spacing={0.75}>
      {run.messages.map((message) => (
        <UserBubble
          key={message.id}
          body={message.body}
          quote={message.quoteText}
        />
      ))}
    </Stack>
  );
}

/** Whether the run picked up its agent session or the transcript. */
export function SessionNoteLine({ run }: { run: StepThreadRun }) {
  const note = sessionNote(run);
  if (!note) return null;
  return (
    <Typography
      variant="body2"
      data-testid="session-note"
      sx={{ color: run.sessionRestored ? "text.disabled" : "warning.main" }}
    >
      {note}
    </Typography>
  );
}
