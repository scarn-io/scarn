"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Chip, Stack, TextField } from "@mui/material";
import type {
  WorkItemCommentContract,
  WorkItemQuestionContract,
} from "@scarn/api/frontend-contracts";
import {
  parseWorkItemCommentId,
  parseWorkItemId,
} from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";

const QUESTION_STATUS: Record<
  WorkItemQuestionContract["status"],
  { label: string; color: "warning" | "success" | "default" }
> = {
  open: { label: "Waiting for reply", color: "warning" },
  answered: { label: "Answered", color: "success" },
  not_needed: { label: "No longer needed", color: "default" },
};

export function QuestionStatusChip({
  status,
}: {
  status: WorkItemQuestionContract["status"];
}) {
  const { label, color } = QUESTION_STATUS[status];
  return (
    <Chip
      size="small"
      variant="outlined"
      color={color}
      label={label}
      sx={{ height: 20, fontSize: 11, fontWeight: 600 }}
    />
  );
}

/** Reply box under an agent question comment; posts a plain comment
 * threaded under the question. It doesn't answer the question — that
 * happens in the agents panel. */
export function QuestionReplyBox({
  comment,
  onReplied,
}: {
  comment: WorkItemCommentContract;
  onReplied: (reply: WorkItemCommentContract) => void;
}) {
  const [replyText, setReplyText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleReply = () => {
    const text = replyText.trim();
    if (!text) return;
    setError(null);
    startTransition(async () => {
      const client = getBrowserScarnApiClient();
      const { data, error: err } = await client.api["work-item-comments"].post({
        workItemId: parseWorkItemId(comment.workItemId),
        body: text,
        parentCommentId: parseWorkItemCommentId(comment.id),
      });
      if (err) {
        setError(parseApiError(err, "Could not send reply. Try again."));
        return;
      }
      setReplyText("");
      onReplied(data);
    });
  };

  return (
    <Stack
      spacing={1}
      sx={{
        px: 1.5,
        py: 1.25,
        borderTop: 1,
        borderColor: "divider",
        backgroundColor: "action.hover",
      }}
    >
      {error ? <Alert severity="error">{error}</Alert> : null}
      <TextField
        placeholder="Reply to this comment…"
        multiline
        minRows={2}
        fullWidth
        size="small"
        value={replyText}
        onChange={(e) => {
          setReplyText(e.target.value);
        }}
        disabled={isPending}
        slotProps={{ htmlInput: { "aria-label": "Reply to question" } }}
      />
      <Stack direction="row" justifyContent="flex-end">
        <Button
          size="small"
          variant="contained"
          onClick={handleReply}
          disabled={isPending || !replyText.trim()}
        >
          Send reply
        </Button>
      </Stack>
    </Stack>
  );
}
