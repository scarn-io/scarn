"use client";

import { Box, Stack, Tooltip, Typography } from "@mui/material";
import type {
  WorkItemContract,
  WorkItemQuestionContract,
} from "@scarn/api/frontend-contracts";
import type { TaskSummary } from "@/components/tasks/task-api";
import { isTaskActive } from "@/components/tasks/task-display";

export type WorkItemRingStatus =
  "closed" | "needs_you" | "in_progress" | "open";

/**
 * The item's status as the viewer sees it: closed, waiting on the viewer
 * (a Task or a pipeline question), something live, or plain open. Personal,
 * so two people can see different statuses on the same item.
 */
export function workItemRingStatus(
  workItem: Pick<WorkItemContract, "state">,
  tasks: readonly Pick<TaskSummary, "status" | "waitingOnYou">[],
  questions: readonly Pick<
    WorkItemQuestionContract,
    "status" | "waitingOnYou"
  >[],
): WorkItemRingStatus {
  if (workItem.state === "closed") return "closed";
  if (
    tasks.some((task) => task.waitingOnYou) ||
    questions.some(
      (question) => question.status === "open" && question.waitingOnYou,
    )
  ) {
    return "needs_you";
  }
  if (tasks.some((task) => isTaskActive(task.status))) return "in_progress";
  return "open";
}

export const RING_STATUS: Record<
  WorkItemRingStatus,
  { label: string; color: string }
> = {
  closed: { label: "Closed", color: "success.main" },
  needs_you: { label: "Needs your reply", color: "error.main" },
  in_progress: { label: "In progress", color: "warning.main" },
  open: { label: "Open", color: "text.disabled" },
};

export function WorkItemStatusRing({
  status,
  size = 16,
}: {
  status: WorkItemRingStatus;
  size?: number;
}) {
  const { label, color } = RING_STATUS[status];
  return (
    <Tooltip title={label}>
      <Box
        role="img"
        aria-label={label}
        data-status={status}
        sx={{
          width: size,
          height: size,
          borderRadius: "50%",
          border: 2,
          borderColor: color,
          bgcolor: status === "closed" ? color : undefined,
          flexShrink: 0,
        }}
      />
    </Tooltip>
  );
}

/** The ring with its label, for the Properties panel's Status row. */
export function WorkItemStatusLabel({
  status,
}: {
  status: WorkItemRingStatus;
}) {
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <WorkItemStatusRing status={status} size={14} />
      <Typography variant="body2" component="span">
        {RING_STATUS[status].label}
      </Typography>
    </Stack>
  );
}
