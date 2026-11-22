/**
 * Display pieces shared by the work item page and the Task view: a Task's
 * name, kind icon, and the pipeline run it belongs to.
 */
import BuildOutlinedIcon from "@mui/icons-material/BuildOutlined";
import CodeIcon from "@mui/icons-material/Code";
import SmartToyOutlinedIcon from "@mui/icons-material/SmartToyOutlined";
import { assertNever } from "@scarn/core/lib/assert-never";
import type { WorkItemExecutionsData } from "@/components/executions/use-work-item-executions";
import { formatElapsedMs } from "@/components/executions/elapsed";
import type { TaskStatus, TaskSummary } from "./task-api";

type NamedTask = Pick<TaskSummary, "name" | "source"> &
  Partial<Pick<TaskSummary, "repoConversation">>;

/** A Task without a work item reads as its conversation's question. */
export function taskDisplayName(task: NamedTask): string {
  if (task.repoConversation) return task.repoConversation.title || "Task";
  if (task.name) return task.name;
  switch (task.source.kind) {
    case "step_definition":
      return task.source.name;
    case "code":
      return "Code step";
    case "mcp_tool":
      return "MCP tool";
    case "prompt":
      return "Prompt task";
    default:
      return assertNever(task.source);
  }
}

export function taskKindLabel(kind: TaskSummary["kind"]): string {
  switch (kind) {
    case "code":
      return "Code step";
    case "mcp_tool":
      return "MCP tool";
    case "agent":
      return "Agent";
    default:
      return assertNever(kind);
  }
}

/** The statuses the work item's agents panel shows. */
export const isTaskActive = (status: TaskStatus): boolean =>
  status === "running" ||
  status === "queued" ||
  status === "waiting_for_person";

export function TaskKindIcon({ kind }: { kind: TaskSummary["kind"] }) {
  switch (kind) {
    case "code":
      return (
        <CodeIcon
          fontSize="small"
          sx={{ color: "text.secondary" }}
          aria-label="Code step"
        />
      );
    case "mcp_tool":
      return (
        <BuildOutlinedIcon
          fontSize="small"
          sx={{ color: "text.secondary" }}
          aria-label="MCP tool"
        />
      );
    case "agent":
      return (
        <SmartToyOutlinedIcon
          fontSize="small"
          sx={{ color: "primary.main" }}
          aria-label="Agent"
        />
      );
    default:
      return assertNever(kind);
  }
}

/**
 * "<pipeline> #<n>" for a Task a pipeline run created, `n` counting the work
 * item's runs oldest first; `null` for a standalone Task or a run not loaded.
 */
export function pipelineRunLabel(
  task: Pick<TaskSummary, "pipelineRunId">,
  executions: Pick<WorkItemExecutionsData, "executions" | "definitionsById">,
): string | null {
  if (!task.pipelineRunId) return null;
  const index = executions.executions.findIndex(
    (execution) => execution.id === task.pipelineRunId,
  );
  const execution = executions.executions[index];
  if (!execution) return null;
  const name =
    executions.definitionsById.get(execution.pipelineDefinitionId)?.name ??
    "Pipeline";
  return `${name} #${String(executions.executions.length - index)}`;
}

/** How long a Task's runs have taken, as of its last read; `null` before any run starts. */
export function taskDuration(
  task: Pick<TaskSummary, "durationMs">,
): string | null {
  return task.durationMs === null ? null : formatElapsedMs(task.durationMs);
}
