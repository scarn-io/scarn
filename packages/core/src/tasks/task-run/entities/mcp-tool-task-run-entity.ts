import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import {
  TaskRunEntityBase,
  type CreateTaskRunEntityBaseProps,
  type TaskRunEntityBaseProps,
  type TaskRunRowProps,
  type TaskToolCall,
} from "./task-run-entity-base";

export type McpToolTaskRunEntityProps = TaskRunEntityBaseProps & {
  toolCallJson: TaskToolCall;
};

export type CreateMcpToolTaskRunEntityProps = CreateTaskRunEntityBaseProps & {
  toolCallJson: TaskToolCall;
};

/**
 * A Task the worker performs by calling one tool on one MCP server directly,
 * with no LLM: it renders `toolCallJson.argsTemplate` against the input and
 * calls `toolCallJson.tool` on `toolCallJson.server`.
 */
export class McpToolTaskRunEntity extends TaskRunEntityBase {
  public readonly kind = "mcp_tool" as const;
  public readonly toolCallJson: TaskToolCall;

  private constructor(props: McpToolTaskRunEntityProps) {
    const { toolCallJson, ...baseProps } = props;
    super(baseProps);

    if (!toolCallJson.server.trim() || !toolCallJson.tool.trim()) {
      throw new CoreValidationError(
        "Task of kind 'mcp_tool' requires toolCallJson: { server, tool }",
        "TASK_TOOL_CALL_REQUIRED",
      );
    }

    this.toolCallJson = toolCallJson;
  }

  static create(props: CreateMcpToolTaskRunEntityProps): McpToolTaskRunEntity {
    return new McpToolTaskRunEntity({
      ...props,
      id: props.id ?? createUuidV7(),
    });
  }

  static rehydrate(props: McpToolTaskRunEntityProps): McpToolTaskRunEntity {
    return new McpToolTaskRunEntity(props);
  }

  protected withBaseProps(props: TaskRunEntityBaseProps): this {
    return new McpToolTaskRunEntity({
      ...props,
      toolCallJson: this.toolCallJson,
    }) as this;
  }

  toJSON(): TaskRunRowProps {
    return {
      ...this.baseJSON(),
      kind: this.kind,
      prompt: null,
      entrypointJson: null,
      toolCallJson: this.toolCallJson,
    };
  }
}
