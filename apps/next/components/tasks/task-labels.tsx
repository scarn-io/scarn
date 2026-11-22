/** Shared display pieces for Tasks: status chip and source label. */
import { Chip, type ChipProps } from "@mui/material";
import { assertNever } from "@scarn/core/lib/assert-never";
import type { TaskStatus, TaskSummary } from "./task-api";

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  waiting_for_concurrency_slot: "Waiting for slot",
  waiting_for_work: "Waiting for work",
  waiting_for_person: "Waiting for person",
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_COLORS: Record<TaskStatus, ChipProps["color"]> = {
  waiting_for_concurrency_slot: "default",
  waiting_for_work: "default",
  waiting_for_person: "warning",
  queued: "default",
  running: "info",
  succeeded: "success",
  failed: "error",
  cancelled: "default",
};

export function TaskStatusChip({ status }: { status: TaskStatus }) {
  return (
    <Chip
      size="small"
      variant="outlined"
      color={STATUS_COLORS[status]}
      label={TASK_STATUS_LABELS[status]}
    />
  );
}

export function taskSourceLabel(source: TaskSummary["source"]): string {
  switch (source.kind) {
    case "step_definition":
      return `${source.name} (${source.key} v${String(source.version)})`;
    case "code":
      return source.name ?? "Code step";
    case "mcp_tool":
      return source.name ?? "MCP tool";
    case "prompt":
      return source.promptPreview
        ? `Prompt: ${source.promptPreview}`
        : "Prompt";
    default:
      return assertNever(source);
  }
}

export function startedByLabel(
  task: Pick<TaskSummary, "startedBy" | "pipelineRunId">,
): string {
  const { startedBy } = task;
  if (startedBy.kind === "user") return startedBy.username ?? "Unknown user";
  if (startedBy.kind === "automation") return startedBy.title ?? startedBy.key;
  return task.pipelineRunId ? "Pipeline" : "—";
}
