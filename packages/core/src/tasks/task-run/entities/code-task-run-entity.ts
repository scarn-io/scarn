import { createUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import {
  TaskRunEntityBase,
  type CreateTaskRunEntityBaseProps,
  type TaskRunEntityBaseProps,
  type TaskEntrypoint,
  type TaskRunRowProps,
} from "./task-run-entity-base";

export type CodeTaskRunEntityProps = TaskRunEntityBaseProps & {
  entrypointJson: TaskEntrypoint;
};

export type CreateCodeTaskRunEntityProps = CreateTaskRunEntityBaseProps & {
  entrypointJson: TaskEntrypoint;
};

/**
 * A Task the worker performs by running a plain step function, found by
 * importing `entrypointJson.sourceFile` from its own checkout.
 */
export class CodeTaskRunEntity extends TaskRunEntityBase {
  public readonly kind = "code" as const;
  public readonly entrypointJson: TaskEntrypoint;

  private constructor(props: CodeTaskRunEntityProps) {
    const { entrypointJson, ...baseProps } = props;
    super(baseProps);

    if (!entrypointJson.sourceFile.trim()) {
      throw new CoreValidationError(
        "Task of kind 'code' requires entrypointJson: { sourceFile }",
        "TASK_ENTRYPOINT_REQUIRED",
      );
    }

    this.entrypointJson = entrypointJson;
  }

  static create(props: CreateCodeTaskRunEntityProps): CodeTaskRunEntity {
    return new CodeTaskRunEntity({ ...props, id: props.id ?? createUuidV7() });
  }

  static rehydrate(props: CodeTaskRunEntityProps): CodeTaskRunEntity {
    return new CodeTaskRunEntity(props);
  }

  protected withBaseProps(props: TaskRunEntityBaseProps): this {
    return new CodeTaskRunEntity({
      ...props,
      entrypointJson: this.entrypointJson,
    }) as this;
  }

  toJSON(): TaskRunRowProps {
    return {
      ...this.baseJSON(),
      kind: this.kind,
      prompt: null,
      entrypointJson: this.entrypointJson,
      toolCallJson: null,
    };
  }
}
