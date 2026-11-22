"use client";

import { Box, Button, InputBase, Stack, Typography } from "@mui/material";
import { useState, type ReactNode } from "react";

/** A decision action with the node the run goes to after it. */
export type WaitChoice = {
  key: string;
  label: string;
  notesRequired: boolean;
  to: string | null;
};

/** What the box asks for: a decision between actions, or a reply. */
export type WaitAsk =
  | {
      kind: "decision";
      choices: WaitChoice[];
      onDecide: (choice: WaitChoice, notes: string) => Promise<boolean>;
    }
  | {
      kind: "reply";
      to: string | null;
      onAnswer: ((body: string) => Promise<boolean>) | null;
      onContinue: (() => Promise<boolean>) | null;
    };

export function Mono({ children }: { children: ReactNode }) {
  return (
    <Box component="span" sx={{ fontFamily: "var(--font-mono)" }}>
      {children}
    </Box>
  );
}

function ChoiceButton({
  choice,
  primary,
  disabled,
  onClick,
}: {
  choice: WaitChoice;
  primary: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const name = choice.to ? `${choice.label} → ${choice.to}` : choice.label;
  return (
    <Button
      size="small"
      variant={primary ? "contained" : "outlined"}
      color={primary ? "primary" : "inherit"}
      disabled={disabled}
      aria-label={name}
      title={
        disabled && choice.notesRequired
          ? `Add a note to ${choice.label}`
          : choice.to
            ? `The run goes to ${choice.to}`
            : undefined
      }
      onClick={onClick}
      sx={{ textTransform: "none", fontWeight: 600 }}
    >
      {choice.label}
      {choice.to ? (
        <Box
          component="span"
          aria-hidden
          sx={{
            ml: 0.75,
            opacity: 0.7,
            fontWeight: 400,
            fontSize: 11.5,
            fontFamily: "var(--font-mono)",
          }}
        >
          → {choice.to}
        </Box>
      ) : null}
    </Button>
  );
}

/**
 * The wait pane's answer box: a notes field with one button per action for a
 * decision, or a reply field with Send answer and Continue without reply.
 * Enter sends a reply (Shift+Enter for a new line); the text clears once an
 * action goes through.
 */
export function WaitAnswerBox({
  ask,
  pending,
}: {
  ask: WaitAsk;
  pending: boolean;
}) {
  const [text, setText] = useState("");
  const trimmed = text.trim();

  const settle = async (done: Promise<boolean>) => {
    if (await done) setText("");
  };

  const sendAnswer = () => {
    if (ask.kind !== "reply" || !ask.onAnswer || trimmed === "" || pending) {
      return;
    }
    void settle(ask.onAnswer(trimmed));
  };

  const requiring =
    ask.kind === "decision"
      ? ask.choices.filter((choice) => choice.notesRequired)
      : [];
  const placeholder =
    ask.kind === "decision"
      ? requiring.length > 0
        ? `Add a note (needed to ${requiring.map((choice) => choice.label).join(" or ")})`
        : "Add a note (optional)"
      : "Answer here, or leave it for a reply on the work item";
  const showField = ask.kind === "decision" || ask.onAnswer !== null;

  return (
    <Box
      sx={{
        borderRadius: 1.5,
        border: 1,
        borderColor: "divider",
        backgroundColor: "background.paper",
        transition: "border-color 120ms",
        "&:focus-within": { borderColor: "warning.main" },
      }}
    >
      {showField ? (
        <InputBase
          multiline
          fullWidth
          minRows={2}
          maxRows={8}
          value={text}
          placeholder={placeholder}
          disabled={pending}
          inputProps={{ "aria-label": placeholder }}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (
              ask.kind === "reply" &&
              event.key === "Enter" &&
              !event.shiftKey
            ) {
              event.preventDefault();
              sendAnswer();
            }
          }}
          sx={{ px: 1.5, pt: 1.25, pb: 0.5, fontSize: 14 }}
        />
      ) : null}
      <Stack
        direction="row"
        alignItems="center"
        flexWrap="wrap"
        useFlexGap
        spacing={1}
        sx={{ px: 1, pb: 1, pt: showField ? 0.5 : 1 }}
      >
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ flex: 1, minWidth: 160, pl: 0.5 }}
        >
          {ask.kind === "decision" ? (
            "Each choice sends the run down a different branch."
          ) : ask.to ? (
            <>
              The run then goes on to <Mono>{ask.to}</Mono>
            </>
          ) : (
            "The run then goes on."
          )}
        </Typography>
        {ask.kind === "decision" ? (
          ask.choices.map((choice, index) => (
            <ChoiceButton
              key={choice.key}
              choice={choice}
              primary={index === 0}
              disabled={pending || (choice.notesRequired && trimmed === "")}
              onClick={() => {
                void settle(ask.onDecide(choice, trimmed));
              }}
            />
          ))
        ) : (
          <>
            {ask.onContinue ? (
              <Button
                size="small"
                variant="outlined"
                color="inherit"
                disabled={pending}
                onClick={() => {
                  if (ask.onContinue) void settle(ask.onContinue());
                }}
                sx={{ textTransform: "none" }}
              >
                Continue without reply
              </Button>
            ) : null}
            {ask.onAnswer ? (
              <Button
                size="small"
                variant="contained"
                disabled={pending || trimmed === ""}
                onClick={sendAnswer}
                sx={{ textTransform: "none", fontWeight: 600 }}
              >
                Send answer
              </Button>
            ) : null}
          </>
        )}
      </Stack>
    </Box>
  );
}
