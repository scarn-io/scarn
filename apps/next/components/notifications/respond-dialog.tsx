"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { UserNotificationContract } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";

export type RespondDialogProps = {
  open: boolean;
  notification: UserNotificationContract | null;
  projectId: string;
  onClose: () => void;
  onResponded: (updated: UserNotificationContract) => void;
};

export function RespondDialog({
  open,
  notification,
  projectId,
  onClose,
  onResponded,
}: RespondDialogProps) {
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleSubmit = () => {
    if (!notification || !answer.trim()) return;
    setError(null);
    startTransition(async () => {
      const client = getBrowserScarnApiClient();
      const { data, error: err } = await client.api
        .projects({ projectId })
        .notifications({ notificationId: notification.id })
        .respond.post({ answer: answer.trim() });
      if (err) {
        setError(parseApiError(err, "Could not submit response. Try again."));
        return;
      }
      onResponded(data);
      setAnswer("");
      onClose();
    });
  };

  const handleClose = () => {
    setAnswer("");
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Respond to Feedback Request</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {notification ? (
            <Typography variant="body2" color="text.secondary">
              {notification.title}
            </Typography>
          ) : null}
          <TextField
            label="Your answer"
            multiline
            minRows={3}
            value={answer}
            onChange={(e) => {
              setAnswer(e.target.value);
            }}
            fullWidth
            autoFocus
            disabled={isPending}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={isPending}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSubmit}
          disabled={isPending || !answer.trim()}
        >
          Submit
        </Button>
      </DialogActions>
    </Dialog>
  );
}
