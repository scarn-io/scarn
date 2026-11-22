import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import {
  TaskRunEntityBase,
  type CreateTaskRunEntityBaseProps,
  type TaskRunEntityBaseProps,
  type TaskRunRowProps,
} from "./task-run-entity-base";

export type AgentTaskRunEntityProps = TaskRunEntityBaseProps & {
  prompt: string;
};

export type CreateAgentTaskRunEntityProps = CreateTaskRunEntityBaseProps & {
  prompt: string;
};

/**
 * A Task an LLM agent performs from a `prompt`. When its agent stops to ask a
 * question the Task yields; the answer starts the Task's next run, the
 * continuation.
 */
export class AgentTaskRunEntity extends TaskRunEntityBase {
  public readonly kind = "agent" as const;
  public readonly prompt: string;

  private constructor(props: AgentTaskRunEntityProps) {
    const { prompt, ...baseProps } = props;
    super(baseProps);

    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      throw new CoreValidationError(
        "Task of kind 'agent' requires a prompt",
        "TASK_PROMPT_REQUIRED",
      );
    }

    this.prompt = trimmedPrompt;
  }

  static create(props: CreateAgentTaskRunEntityProps): AgentTaskRunEntity {
    return new AgentTaskRunEntity({ ...props, id: props.id ?? createUuidV7() });
  }

  static rehydrate(props: AgentTaskRunEntityProps): AgentTaskRunEntity {
    return new AgentTaskRunEntity(props);
  }

  protected withBaseProps(props: TaskRunEntityBaseProps): this {
    return new AgentTaskRunEntity({
      ...props,
      prompt: this.prompt,
    }) as this;
  }

  toJSON(): TaskRunRowProps {
    return {
      ...this.baseJSON(),
      kind: this.kind,
      prompt: this.prompt,
      entrypointJson: null,
      toolCallJson: null,
    };
  }
}
