/**
 * A Task's instructions by kind: an `agent` Task has a prompt, a `code` Task
 * an entrypoint, and an `mcp_tool` Task a tool call — and none of the
 * others'. Also builds a Task's runs, which carry those instructions
 * read-only.
 */
import type {
  AnyJsonObject,
  AnyJsonValue,
} from "@scarn/core/common/contracts/json";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { assertNever } from "@scarn/core/lib/assert-never";
import { CoreValidationError } from "@scarn/core/lib/errors";
import {
  TaskRunEntity,
  type TaskEntrypoint,
  type TaskKind,
  type TaskRunReason,
  type TaskRunStatus,
  type TaskToolCall,
} from "@scarn/core/tasks/task-run/domain/task-run-entity";

type TaskInstructionFields = {
  kind: TaskKind;
  prompt: string | null;
  entrypointJson: TaskEntrypoint | null;
  toolCallJson: TaskToolCall | null;
};

const notAllowed = (kind: TaskKind, field: string, code: string) =>
  new CoreValidationError(
    `Task of kind '${kind}' must not have ${field}`,
    code,
  );

/**
 * Checks a Task's instructions against its kind and returns the trimmed
 * prompt, or null.
 */
export const validTaskPrompt = ({
  kind,
  prompt,
  entrypointJson,
  toolCallJson,
}: TaskInstructionFields): string | null => {
  const trimmed = prompt?.trim() || null;
  if (kind !== "agent" && trimmed !== null) {
    throw notAllowed(kind, "a prompt", "TASK_PROMPT_NOT_ALLOWED");
  }
  if (kind !== "code" && entrypointJson) {
    throw notAllowed(kind, "entrypointJson", "TASK_ENTRYPOINT_NOT_ALLOWED");
  }
  if (kind !== "mcp_tool" && toolCallJson) {
    throw notAllowed(kind, "toolCallJson", "TASK_TOOL_CALL_NOT_ALLOWED");
  }
  switch (kind) {
    case "agent":
      if (trimmed === null) {
        throw new CoreValidationError(
          "Task of kind 'agent' requires a prompt",
          "TASK_PROMPT_REQUIRED",
        );
      }
      return trimmed;
    case "code":
      if (!entrypointJson) {
        throw new CoreValidationError(
          "Task of kind 'code' requires entrypointJson: { sourceFile }",
          "TASK_ENTRYPOINT_REQUIRED",
        );
      }
      return null;
    case "mcp_tool":
      if (!toolCallJson) {
        throw new CoreValidationError(
          "Task of kind 'mcp_tool' requires toolCallJson: { server, tool }",
          "TASK_TOOL_CALL_REQUIRED",
        );
      }
      return null;
    default:
      return assertNever(kind);
  }
};

/** The run-specific fields a new TaskRun of a Task needs. */
export type NewTaskRunProps = {
  id?: UuidV7 | undefined;
  number: number;
  reason: TaskRunReason;
  status: TaskRunStatus;
  baseBranch?: string | null | undefined;
  baseCommit?: string | null | undefined;
  environmentVersionId?: UuidV7 | null | undefined;
  now: Date;
};

type TaskForRun = TaskInstructionFields & {
  id: UuidV7;
  projectId: UuidV7;
  workItemId: UuidV7 | null;
  taskExecutionConfigId: UuidV7 | null;
  name: string | null;
  resultSchemaJson: AnyJsonObject | null;
  heartbeatSeconds: number | null;
  executionTimeoutSeconds: number | null;
  inputJson: AnyJsonValue | null;
};

/** A new run of `task`, carrying the Task's instructions read-only. */
export const newTaskRun = (
  task: TaskForRun,
  props: NewTaskRunProps,
): TaskRunEntity => {
  const shared = {
    id: props.id,
    taskId: task.id,
    number: props.number,
    reason: props.reason,
    projectId: task.projectId,
    workItemId: task.workItemId,
    taskExecutionConfigId: task.taskExecutionConfigId,
    name: task.name,
    resultSchemaJson: task.resultSchemaJson,
    baseBranch: props.baseBranch ?? null,
    baseCommit: props.baseCommit ?? null,
    environmentVersionId: props.environmentVersionId ?? null,
    heartbeatSeconds: task.heartbeatSeconds,
    executionTimeoutSeconds: task.executionTimeoutSeconds,
    status: props.status,
    evaluatedAt: props.now,
    inputJson: task.inputJson,
    startedAt: null,
    completedAt: null,
    createdAt: props.now,
    updatedAt: props.now,
  };
  switch (task.kind) {
    case "agent":
      return TaskRunEntity.create({
        ...shared,
        kind: "agent",
        prompt: task.prompt ?? "",
      });
    case "code":
      return TaskRunEntity.create({
        ...shared,
        kind: "code",
        entrypointJson: task.entrypointJson as TaskEntrypoint,
      });
    case "mcp_tool":
      return TaskRunEntity.create({
        ...shared,
        kind: "mcp_tool",
        toolCallJson: task.toolCallJson as TaskToolCall,
      });
    default:
      return assertNever(task.kind);
  }
};
