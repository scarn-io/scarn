"use client";

import { useMemo, type ReactNode } from "react";
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Stack,
  Typography,
} from "@mui/material";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import Link from "next/link";
import type { WorkItemConversationContract } from "@scarn/api/frontend-contracts";
import { useProjectPath } from "@/components/project-route-context";
import { formatRelativeTime } from "@/components/executions/format-datetime";
import type { WorkItemExecutionsData } from "@/components/executions/use-work-item-executions";
import type { TaskSummary } from "@/components/tasks/task-api";
import { taskRunPath } from "@/components/runs/task-run-path";
import { TaskStatusChip } from "@/components/tasks/task-labels";
import {
  TaskKindIcon,
  pipelineRunLabel,
  taskDisplayName,
  taskDuration,
  taskKindLabel,
} from "@/components/tasks/task-display";
import { useWorkItemBlocks } from "./use-work-item-blocks";
import { useResolvedWorkItems } from "./work-item-relationship-list";

/**
 * The Tasks tab: every Task on the work item, agent or code, newest first.
 * Each row links to the Task's run page.
 */
export function WorkItemTasksTab({
  workItemId,
  tasks,
  loading,
  error,
  conversations,
  executions,
}: {
  workItemId: string;
  tasks: readonly TaskSummary[];
  loading: boolean;
  error: string;
  conversations: readonly WorkItemConversationContract[];
  executions: Pick<WorkItemExecutionsData, "executions" | "definitionsById">;
}) {
  const hasWaitingForWork = tasks.some(
    (task) => task.status === "waiting_for_work",
  );
  const blockerTitles = useOpenBlockerTitles(workItemId, hasWaitingForWork);
  const messageCounts = useMemo(
    () =>
      new Map(
        conversations.map((conversation) => [
          conversation.id,
          conversation.messages.length,
        ]),
      ),
    [conversations],
  );

  if (error) return <Alert severity="error">{error}</Alert>;
  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }
  if (tasks.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No tasks on this work item yet.
      </Typography>
    );
  }

  return (
    <Box
      component="ul"
      aria-label="Tasks"
      sx={{
        listStyle: "none",
        m: 0,
        p: 0,
        border: 1,
        borderColor: "divider",
        borderRadius: 2,
        overflow: "hidden",
        backgroundColor: "background.paper",
      }}
    >
      {tasks.map((task, index) => (
        <Box
          component="li"
          key={task.id}
          sx={{ borderTop: index ? 1 : 0, borderColor: "divider" }}
        >
          <TaskRow
            task={task}
            caption={taskCaption(
              task,
              pipelineRunLabel(task, executions),
              task.conversationId
                ? messageCounts.get(task.conversationId)
                : undefined,
            )}
            blockerTitles={blockerTitles}
          />
        </Box>
      ))}
    </Box>
  );
}

function taskCaption(
  task: TaskSummary,
  runLabel: string | null,
  messageCount: number | undefined,
): string {
  const parts = [taskKindLabel(task.kind)];
  if (runLabel) parts.push(runLabel);
  if (messageCount) {
    parts.push(
      `${String(messageCount)} ${messageCount === 1 ? "message" : "messages"}`,
    );
  }
  const duration = taskDuration(task);
  if (duration) parts.push(duration);
  parts.push(`updated ${formatRelativeTime(task.updatedAt)}`);
  return parts.join(" · ");
}

function TaskRow({
  task,
  caption,
  blockerTitles,
}: {
  task: TaskSummary;
  caption: string;
  blockerTitles: readonly string[];
}) {
  const projectPath = useProjectPath();
  let note: ReactNode = null;
  if (task.status === "waiting_for_work") {
    note = (
      <Typography variant="caption" color="text.secondary">
        {blockerTitles.length > 0
          ? `Will start when ${blockerTitles.join(", ")} ${blockerTitles.length === 1 ? "closes" : "close"}`
          : "Will start when its blockers close"}
      </Typography>
    );
  } else if (task.status === "waiting_for_concurrency_slot") {
    note = (
      <Typography variant="caption" color="text.secondary">
        Will start when another task of its step on this item ends
      </Typography>
    );
  } else if (task.status === "failed") {
    note = (
      <Typography variant="caption" color="error" data-testid="task-error">
        {task.latest?.kind === "error" ? task.latest.text : "Failed"}
      </Typography>
    );
  }

  return (
    <Box
      component={Link}
      href={taskRunPath(projectPath, task)}
      data-testid="task-row"
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        px: 2,
        py: 1.25,
        color: "inherit",
        textDecoration: "none",
        "&:hover": { backgroundColor: "action.hover" },
      }}
    >
      <TaskKindIcon kind={task.kind} />
      <Stack spacing={0.25} sx={{ flex: 1, minWidth: 0 }}>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          useFlexGap
          flexWrap="wrap"
        >
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {taskDisplayName(task)}
          </Typography>
          <TaskStatusChip status={task.status} />
          {task.waitingOnYou ? (
            <Chip size="small" color="warning" label="You" />
          ) : null}
        </Stack>
        <Typography variant="caption" color="text.secondary">
          {caption}
        </Typography>
        {note}
      </Stack>
      <ChevronRightIcon sx={{ color: "text.disabled" }} aria-hidden />
    </Box>
  );
}

/** The titles of the open items blocking this one, while any Task waits on them. */
function useOpenBlockerTitles(workItemId: string, enabled: boolean): string[] {
  const { blockedBy } = useWorkItemBlocks(workItemId);
  const ids = useMemo(
    () => (enabled ? blockedBy.map((block) => block.blockingWorkItemId) : []),
    [blockedBy, enabled],
  );
  const itemsById = useResolvedWorkItems(ids);
  return ids.flatMap((id) => {
    const item = itemsById[id];
    return item && item.state !== "closed" ? [item.title] : [];
  });
}
