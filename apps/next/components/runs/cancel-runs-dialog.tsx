"use client";

import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from "@mui/material";
import { useEffect, useState } from "react";
import { apiErrorCode, parseApiError } from "@/app/_lib/api-error";
import type { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import type { ProjectRun } from "./runs-api";

export type CancelRunsApiClient = Pick<
  ReturnType<typeof getBrowserScarnApiClient>,
  "api"
>;

/** A run the dialog can cancel: a pipeline run, or a step or prompt Task. */
export type CancellableRun = Pick<ProjectRun, "id"> & {
  type: ProjectRun["type"];
};

export type CancelRunsResult = {
  cancelledIds: string[];
  /** Already finished by the time the request landed. */
  skippedIds: string[];
  failedIds: string[];
};

const FALLBACK_ERROR = "Failed to cancel runs";

/**
 * Stops pipeline runs with one batch call and Tasks with one call each, and
 * sorts every id into cancelled, skipped (it had already finished) or failed.
 */
export async function cancelRuns(
  apiClient: CancelRunsApiClient,
  runs: readonly CancellableRun[],
): Promise<CancelRunsResult & { error: string | null }> {
  const pipelineIds = runs
    .filter((run) => run.type === "pipeline")
    .map((run) => run.id);
  const taskIds = runs
    .filter((run) => run.type !== "pipeline")
    .map((run) => run.id);
  const result: CancelRunsResult = {
    cancelledIds: [],
    skippedIds: [],
    failedIds: [],
  };
  let error: string | null = null;

  const cancelPipelines = async () => {
    if (pipelineIds.length === 0) return;
    try {
      const response = await apiClient.api[
        "pipeline-executions"
      ].batch.cancel.put({ input: pipelineIds.map(parseUuidV7) });
      if (response.error) {
        error = parseApiError(response.error, FALLBACK_ERROR);
        result.failedIds.push(...pipelineIds);
        return;
      }
      result.cancelledIds.push(...response.data.cancelledIds);
      result.skippedIds.push(...response.data.skippedIds);
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : FALLBACK_ERROR;
      result.failedIds.push(...pipelineIds);
    }
  };

  const cancelTasks = async () => {
    const settled = await Promise.allSettled(
      taskIds.map((taskId) =>
        apiClient.api.tasks({ taskId: parseUuidV7(taskId) }).cancel.post(),
      ),
    );
    settled.forEach((outcome, index) => {
      const taskId = taskIds[index] as string;
      if (outcome.status === "rejected") {
        error =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : FALLBACK_ERROR;
        result.failedIds.push(taskId);
        return;
      }
      const response = outcome.value;
      if (!response.error) {
        result.cancelledIds.push(taskId);
        return;
      }
      if (apiErrorCode(response.error) === "TASK_ALREADY_ENDED") {
        result.skippedIds.push(taskId);
        return;
      }
      error = parseApiError(response.error, FALLBACK_ERROR);
      result.failedIds.push(taskId);
    });
  };

  await Promise.all([cancelPipelines(), cancelTasks()]);
  return { ...result, error };
}

/** One line on how a batch cancel went. */
export function cancelRunsSummary({
  cancelledIds,
  skippedIds,
  failedIds,
}: CancelRunsResult): string {
  const runs = (count: number) =>
    `${String(count)} run${count === 1 ? "" : "s"}`;
  const parts = [`Cancelled ${runs(cancelledIds.length)}.`];
  if (skippedIds.length > 0) {
    parts.push(
      `${runs(skippedIds.length)} ${skippedIds.length === 1 ? "was" : "were"} no longer in progress and ${skippedIds.length === 1 ? "was" : "were"} skipped.`,
    );
  }
  if (failedIds.length > 0) {
    parts.push(`${runs(failedIds.length)} could not be cancelled.`);
  }
  return parts.join(" ");
}

/**
 * Confirmation dialog for cancelling a batch of runs.
 *
 * `onClose` dismisses the dialog without acting (the "Cancel" button, and
 * clicking outside/pressing escape); `onCancelled` fires once the cancel
 * requests have settled and at least one of them went through. Naming it
 * this way — rather than reusing "cancel" for both — keeps "dismiss this
 * dialog" and "cancel the selected runs" from colliding, since the confirm
 * button also needs a label that isn't literally "Cancel" for the same
 * reason. When every request fails, the dialog stays open with the error.
 */
export function CancelRunsDialog({
  open,
  runs,
  apiClient,
  onClose,
  onCancelled,
}: {
  open: boolean;
  runs: readonly CancellableRun[];
  apiClient: CancelRunsApiClient;
  onClose: () => void;
  onCancelled: (result: CancelRunsResult) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const count = runs.length;

  useEffect(() => {
    if (open) setError("");
  }, [open]);

  const handleConfirm = async () => {
    setSubmitting(true);
    setError("");
    try {
      const { error: failure, ...result } = await cancelRuns(apiClient, runs);
      if (
        result.failedIds.length > 0 &&
        result.cancelledIds.length === 0 &&
        result.skippedIds.length === 0
      ) {
        setError(failure ?? FALLBACK_ERROR);
        return;
      }
      onCancelled(result);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!submitting) onClose();
      }}
    >
      <DialogTitle>
        {`Cancel ${String(count)} run${count === 1 ? "" : "s"}?`}
      </DialogTitle>
      <DialogContent>
        <DialogContentText>
          This stops queued and in-progress work. Runs that have already
          finished are unaffected and won&apos;t be resumed.
        </DialogContentText>
        {error ? (
          <DialogContentText sx={{ color: "error.main", mt: 2 }}>
            {error}
          </DialogContentText>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          onClick={() => {
            void handleConfirm();
          }}
          variant="contained"
          color="warning"
          disabled={submitting || count === 0}
        >
          Cancel runs
        </Button>
      </DialogActions>
    </Dialog>
  );
}
