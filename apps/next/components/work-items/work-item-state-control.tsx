"use client";

import { useState, useTransition } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
} from "@mui/material";
import type { WorkItemContract } from "@scarn/api/frontend-contracts";
import { parseWorkItemId } from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { parseApiError } from "@/app/_lib/api-error";

type CloseReason = NonNullable<WorkItemContract["closeReason"]>;

const CLOSE_REASON_LABELS: Record<CloseReason, string> = {
  completed: "Completed",
  out_of_scope: "Out of scope",
  superseded: "Superseded",
};

const CLOSE_REASONS = Object.keys(CLOSE_REASON_LABELS) as CloseReason[];

/**
 * Close (with a reason and an optional resolution) or reopen a work item.
 * A non-empty resolution is posted to the thread by the server, so
 * `onChanged` reports whether the comments need reloading.
 */
export function WorkItemStateButton({
  workItem,
  onChanged,
}: {
  workItem: WorkItemContract;
  onChanged: (updated: WorkItemContract, postedComment: boolean) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reason, setReason] = useState<CloseReason>("completed");
  const [resolution, setResolution] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const submit = (
    body:
      | { state: "closed"; reason: CloseReason; resolution: string | null }
      | { state: "open" },
  ) => {
    setError(null);
    startTransition(async () => {
      const client = getBrowserScarnApiClient();
      const { data, error: err } = await client.api["work-items"]({
        workItemId: parseWorkItemId(workItem.id),
      }).state.put(body);
      if (err) {
        setError(
          parseApiError(
            err,
            body.state === "closed"
              ? "Could not close this work item. Try again."
              : "Could not reopen this work item. Try again.",
          ),
        );
        return;
      }
      onChanged(data, body.state === "closed" && Boolean(body.resolution));
      setDialogOpen(false);
    });
  };

  if (workItem.state === "closed") {
    return (
      <Stack spacing={1} alignItems="flex-end">
        <Button
          variant="outlined"
          size="small"
          disabled={isPending}
          onClick={() => {
            submit({ state: "open" });
          }}
        >
          Reopen
        </Button>
        {error ? <Alert severity="error">{error}</Alert> : null}
      </Stack>
    );
  }

  return (
    <>
      <Button
        variant="outlined"
        size="small"
        onClick={() => {
          setReason("completed");
          setResolution("");
          setError(null);
          setDialogOpen(true);
        }}
      >
        Close
      </Button>
      <Dialog
        open={dialogOpen}
        onClose={() => {
          if (!isPending) setDialogOpen(false);
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Close work item</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {error ? <Alert severity="error">{error}</Alert> : null}
            <TextField
              select
              label="Reason"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value as CloseReason);
              }}
              disabled={isPending}
            >
              {CLOSE_REASONS.map((value) => (
                <MenuItem key={value} value={value}>
                  {CLOSE_REASON_LABELS[value]}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="Resolution"
              placeholder="What was the outcome? Posted as a reply."
              multiline
              minRows={3}
              value={resolution}
              onChange={(e) => {
                setResolution(e.target.value);
              }}
              disabled={isPending}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setDialogOpen(false);
            }}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={isPending}
            onClick={() => {
              submit({
                state: "closed",
                reason,
                resolution: resolution.trim() || null,
              });
            }}
          >
            Close work item
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
