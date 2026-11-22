"use client";

import { useRef, useState } from "react";
import { Alert, Button, Stack } from "@mui/material";
import Link from "next/link";
import type { TaskRunContract } from "@scarn/api/frontend-contracts";
import {
  useProjectPath,
  useProjectRoute,
} from "@/components/project-route-context";
import { retryTask, type TaskDetail } from "./task-api";

function isTaskRetryEligible(
  task: TaskDetail,
  latest: TaskRunContract | null,
): boolean {
  if (task.status !== "failed" && task.status !== "cancelled") return false;
  if (latest === null) return task.status === "cancelled";
  return (
    ["failed", "timeout", "abandoned", "cancelled"].includes(latest.status) ||
    (task.status === "cancelled" && latest.status === "yielded")
  );
}

export function TaskRetryAction({
  task,
  runs,
  onRefresh,
  onRetried,
}: {
  task: TaskDetail;
  runs: readonly TaskRunContract[];
  onRefresh: () => void;
  onRetried: () => void;
}) {
  const { isMember, permissions } = useProjectRoute();
  const projectPath = useProjectPath();
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState("");
  const latest = runs.at(-1) ?? null;
  const canWrite = isMember && permissions.includes("executions:write");
  const eligible = isTaskRetryEligible(task, latest);

  if (!canWrite) return null;
  if (task.pipelineRunId) {
    return task.status === "failed" || task.status === "cancelled" ? (
      <Button
        component={Link}
        href={projectPath("runs", task.pipelineRunId)}
        variant="outlined"
        size="small"
        sx={{ alignSelf: "flex-start" }}
      >
        Re-run in pipeline
      </Button>
    ) : null;
  }
  if (!eligible && !error) return null;

  const submit = async () => {
    if (submitting.current || !eligible) return;
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      await retryTask(task.id, latest?.id ?? null);
      onRetried();
      onRefresh();
    } catch (cause) {
      const code =
        typeof cause === "object" && cause !== null && "code" in cause
          ? cause.code
          : null;
      setError(
        code === "TASK_RETRY_STALE_RUN" || code === "TASK_NOT_RETRYABLE"
          ? "This task changed. Refresh the task, then retry if it is still eligible."
          : code === "Scarn.ConcurrencyGroupFull"
            ? "The concurrency group is full. Wait for another task to finish, then retry."
            : "Could not retry the task. Refresh to check whether it started, then try again.",
      );
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  return (
    <Stack spacing={1} alignItems="flex-start">
      {eligible ? (
        <Button
          variant="outlined"
          size="small"
          disabled={pending}
          onClick={() => {
            void submit();
          }}
        >
          {pending ? "Retrying…" : "Retry task"}
        </Button>
      ) : null}
      {error ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={onRefresh}>
              Refresh task
            </Button>
          }
        >
          {error}
        </Alert>
      ) : null}
    </Stack>
  );
}
