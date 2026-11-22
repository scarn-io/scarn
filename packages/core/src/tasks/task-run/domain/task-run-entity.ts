/**
 * `TaskRunEntity` is a discriminated union of per-kind leaf classes
 * (`AgentTaskRunEntity`, `CodeTaskRunEntity`, `McpToolTaskRunEntity`) rather
 * than one flat class, so each kind carries only the instructions that apply
 * to it. Callers narrow on `.kind` to read kind-specific fields.
 *
 * `TaskRunEntity` is also a companion value with `create`/`rehydrate`, which
 * dispatch on `kind` to the matching leaf class — so callers that don't know
 * the kind up front still write `TaskRunEntity.create(...)`. Callers that do know
 * it can use `AgentTaskRunEntity.create(...)` / `CodeTaskRunEntity.create(...)`
 * directly. See `entities/task-entity-base.ts` for the shared lifecycle.
 */
import { CoreValidationError } from "@scarn/core/lib/errors";
import {
  AgentTaskRunEntity,
  type CreateAgentTaskRunEntityProps,
} from "../entities/agent-task-run-entity";
import {
  CodeTaskRunEntity,
  type CreateCodeTaskRunEntityProps,
} from "../entities/code-task-run-entity";
import {
  McpToolTaskRunEntity,
  type CreateMcpToolTaskRunEntityProps,
} from "../entities/mcp-tool-task-run-entity";
import type { TaskRunRowProps } from "../entities/task-run-entity-base";

export {
  taskRunStatusValues,
  taskKindValues,
  taskRunStatusForResult,
  taskRunResultStatusValues,
  taskRunReasonValues,
  TaskRunEntityBase,
  type TaskRunReason,
  type TaskRunResultStatus,
  type TaskRunCompletion,
  type TaskRunStatus,
  type TaskKind,
  type TaskEntrypoint,
  type TaskToolCall,
  type TaskRunEntityBaseProps,
  type CreateTaskRunEntityBaseProps,
  type TaskRunRowProps,
} from "../entities/task-run-entity-base";
export {
  AgentTaskRunEntity,
  type AgentTaskRunEntityProps,
  type CreateAgentTaskRunEntityProps,
} from "../entities/agent-task-run-entity";
export {
  CodeTaskRunEntity,
  type CodeTaskRunEntityProps,
  type CreateCodeTaskRunEntityProps,
} from "../entities/code-task-run-entity";
export {
  McpToolTaskRunEntity,
  type McpToolTaskRunEntityProps,
  type CreateMcpToolTaskRunEntityProps,
} from "../entities/mcp-tool-task-run-entity";

export type TaskRunEntity =
  AgentTaskRunEntity | CodeTaskRunEntity | McpToolTaskRunEntity;

export type CreateTaskRunEntityProps =
  | (CreateAgentTaskRunEntityProps & { kind: "agent" })
  | (CreateCodeTaskRunEntityProps & { kind: "code" })
  | (CreateMcpToolTaskRunEntityProps & { kind: "mcp_tool" });

type InstructionProps = Pick<
  TaskRunRowProps,
  "kind" | "prompt" | "entrypointJson" | "toolCallJson"
>;

/**
 * Mirrors the `tasks_kind_instructions_check` constraint from the other
 * side: rejects the instruction fields that belong to *other* kinds. The
 * leaf classes enforce their own required fields; this catches a row or
 * untyped caller that carries several.
 */
const assertNoForeignInstructions = (props: InstructionProps) => {
  if (props.kind !== "agent" && props.prompt?.trim()) {
    throw new CoreValidationError(
      `Task of kind '${props.kind}' must not have a prompt`,
      "TASK_PROMPT_NOT_ALLOWED",
    );
  }
  if (props.kind !== "code" && props.entrypointJson) {
    throw new CoreValidationError(
      `Task of kind '${props.kind}' must not have entrypointJson`,
      "TASK_ENTRYPOINT_NOT_ALLOWED",
    );
  }
  if (props.kind !== "mcp_tool" && props.toolCallJson) {
    throw new CoreValidationError(
      `Task of kind '${props.kind}' must not have toolCallJson`,
      "TASK_TOOL_CALL_NOT_ALLOWED",
    );
  }
};

const unsupportedKind = (kind: string) =>
  new CoreValidationError(
    `Task kind '${kind}' is not supported`,
    "TASK_KIND_UNSUPPORTED",
  );

export const TaskRunEntity = {
  /** Constructs the leaf class matching `props.kind`. */
  create(props: CreateTaskRunEntityProps): TaskRunEntity {
    assertNoForeignInstructions(props);
    switch (props.kind) {
      case "agent":
        return AgentTaskRunEntity.create(props);
      case "code":
        return CodeTaskRunEntity.create(props);
      case "mcp_tool":
        return McpToolTaskRunEntity.create(props);
      default:
        throw unsupportedKind((props as { kind: string }).kind);
    }
  },

  /**
   * Rehydrates the leaf class matching `row.kind` from the flat, nullable
   * `tasks` row shape.
   */
  rehydrate(row: TaskRunRowProps): TaskRunEntity {
    assertNoForeignInstructions(row);
    const { kind, prompt, entrypointJson, toolCallJson, ...base } = row;
    switch (kind) {
      case "agent":
        if (!prompt?.trim()) {
          throw new CoreValidationError(
            "Task of kind 'agent' requires a prompt",
            "TASK_PROMPT_REQUIRED",
          );
        }
        return AgentTaskRunEntity.rehydrate({ ...base, prompt });
      case "code":
        if (!entrypointJson) {
          throw new CoreValidationError(
            "Task of kind 'code' requires entrypointJson: { sourceFile }",
            "TASK_ENTRYPOINT_REQUIRED",
          );
        }
        return CodeTaskRunEntity.rehydrate({ ...base, entrypointJson });
      case "mcp_tool":
        if (!toolCallJson) {
          throw new CoreValidationError(
            "Task of kind 'mcp_tool' requires toolCallJson: { server, tool }",
            "TASK_TOOL_CALL_REQUIRED",
          );
        }
        return McpToolTaskRunEntity.rehydrate({ ...base, toolCallJson });
      default:
        throw unsupportedKind(String(kind));
    }
  },
};
