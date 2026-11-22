import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { assertNever } from "@scarn/core/lib/assert-never";
import { CoreValidationError } from "@scarn/core/lib/errors";
import type {
  TaskRunEntity,
  TaskEntrypoint,
  TaskKind,
  TaskToolCall,
} from "@scarn/core/tasks/task-run/domain/task-run-entity";
import type {
  StepDefinitionEntity,
  StepDefinitionKind,
} from "./step-definition-entity";

type SharedTaskInstructions = {
  resultSchemaJson: AnyJsonObject | null;
  taskExecutionConfigId: UuidV7 | null;
  name: string | null;
};

export type TaskInstructions =
  | (SharedTaskInstructions & { kind: "agent"; prompt: string })
  | (SharedTaskInstructions & { kind: "code"; entrypointJson: TaskEntrypoint })
  | (SharedTaskInstructions & { kind: "mcp_tool"; toolCallJson: TaskToolCall });

export const taskKindForStepDefinitionKind = (
  kind: StepDefinitionKind,
): TaskKind => {
  switch (kind) {
    case "code":
      return "code";
    case "built_in":
    case "user_defined":
      return "agent";
    case "mcp_tool":
      return "mcp_tool";
    default:
      return assertNever(kind);
  }
};

/**
 * Copies a step definition version's instructions onto a Task (A-5): `code`
 * steps become `code` Tasks, which need an entrypoint; `mcp_tool` steps
 * become `mcp_tool` Tasks, which need a tool call; `user_defined` and
 * `built_in` steps become `agent` Tasks, which need a prompt. The Task points
 * at the step's execution config row rather than copying it (D4) and takes
 * the step's name (D5).
 */
export const buildTaskInstructionsFromStepDefinition = (
  stepDefinition: Pick<
    StepDefinitionEntity,
    | "id"
    | "kind"
    | "prompt"
    | "resultSchemaJson"
    | "entrypointJson"
    | "toolCallJson"
    | "taskExecutionConfigId"
    | "name"
  >,
): TaskInstructions => {
  const shared = {
    resultSchemaJson: stepDefinition.resultSchemaJson,
    taskExecutionConfigId: stepDefinition.taskExecutionConfigId,
    name: stepDefinition.name,
  };

  const taskKind = taskKindForStepDefinitionKind(stepDefinition.kind);
  switch (taskKind) {
    case "code":
      if (!stepDefinition.entrypointJson) {
        throw new CoreValidationError(
          `Step definition ${stepDefinition.id} has no entrypoint to run as a code task`,
          "STEP_DEFINITION_ENTRYPOINT_REQUIRED_FOR_TASK",
        );
      }
      return {
        ...shared,
        kind: "code",
        entrypointJson: stepDefinition.entrypointJson,
      };
    case "agent":
      if (!stepDefinition.prompt) {
        throw new CoreValidationError(
          `Step definition ${stepDefinition.id} has no prompt to run as an agent task`,
          "STEP_DEFINITION_PROMPT_REQUIRED_FOR_TASK",
        );
      }
      return { ...shared, kind: "agent", prompt: stepDefinition.prompt };
    case "mcp_tool":
      if (!stepDefinition.toolCallJson) {
        throw new CoreValidationError(
          `Step definition ${stepDefinition.id} has no tool call to run as an mcp_tool task`,
          "STEP_DEFINITION_TOOL_CALL_REQUIRED_FOR_TASK",
        );
      }
      return {
        ...shared,
        kind: "mcp_tool",
        toolCallJson: stepDefinition.toolCallJson,
      };
    default:
      return assertNever(taskKind);
  }
};

/** Copies an existing Task's instructions, e.g. to rerun it as a fresh Task. */
export const taskInstructionsFromTask = (
  task: TaskRunEntity,
): TaskInstructions => {
  const shared = {
    resultSchemaJson: task.resultSchemaJson,
    taskExecutionConfigId: task.taskExecutionConfigId,
    name: task.name,
  };
  switch (task.kind) {
    case "agent":
      return { ...shared, kind: "agent", prompt: task.prompt };
    case "code":
      return { ...shared, kind: "code", entrypointJson: task.entrypointJson };
    case "mcp_tool":
      return { ...shared, kind: "mcp_tool", toolCallJson: task.toolCallJson };
    default:
      return assertNever(task);
  }
};
