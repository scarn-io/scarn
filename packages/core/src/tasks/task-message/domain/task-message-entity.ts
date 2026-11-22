import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import { normalizeDate } from "@scarn/core/work-items/work-item/domain/date-utils";

export const TASK_MESSAGE_BODY_MAX_LENGTH = 20_000;
export const TASK_MESSAGE_QUOTE_TEXT_MAX_LENGTH = 4_000;

export type TaskMessageEntityProps = {
  id: UuidV7;
  taskId: UuidV7;
  authorUserId: UuidV7;
  body: string;
  quoteText?: string | null | undefined;
  createdAt?: Date | string | null | undefined;
};

export type CreateTaskMessageProps = Omit<TaskMessageEntityProps, "id"> & {
  id?: UuidV7 | undefined;
};

/**
 * A message a user sent to a step, attached to the Task (run) it started.
 * The run's messages are the messages on every Task in its previous-run chain.
 */
export class TaskMessageEntity {
  public readonly id: UuidV7;
  public readonly taskId: UuidV7;
  public readonly authorUserId: UuidV7;
  public readonly body: string;
  public readonly quoteText: string | null;
  public readonly createdAt: Date | null | undefined;

  private constructor(props: TaskMessageEntityProps) {
    const body = props.body.trim();
    if (!body) {
      throw new CoreValidationError(
        "Task message body is required",
        "TASK_MESSAGE_BODY_REQUIRED",
      );
    }
    if (body.length > TASK_MESSAGE_BODY_MAX_LENGTH) {
      throw new CoreValidationError(
        `Task message body must be at most ${String(TASK_MESSAGE_BODY_MAX_LENGTH)} characters`,
        "TASK_MESSAGE_BODY_TOO_LONG",
      );
    }

    const quoteText = props.quoteText?.trim() || null;
    if (
      quoteText !== null &&
      quoteText.length > TASK_MESSAGE_QUOTE_TEXT_MAX_LENGTH
    ) {
      throw new CoreValidationError(
        `Task message quoteText must be at most ${String(TASK_MESSAGE_QUOTE_TEXT_MAX_LENGTH)} characters`,
        "TASK_MESSAGE_QUOTE_TEXT_TOO_LONG",
      );
    }

    this.id = parseUuidV7(props.id);
    this.taskId = parseUuidV7(props.taskId);
    this.authorUserId = parseUuidV7(props.authorUserId);
    this.body = body;
    this.quoteText = quoteText;
    this.createdAt = normalizeDate(props.createdAt);
  }

  static create(props: CreateTaskMessageProps): TaskMessageEntity {
    return new TaskMessageEntity({ ...props, id: props.id ?? createUuidV7() });
  }

  static rehydrate(props: TaskMessageEntityProps): TaskMessageEntity {
    return new TaskMessageEntity(props);
  }

  toJSON(): TaskMessageEntityProps {
    return {
      id: this.id,
      taskId: this.taskId,
      authorUserId: this.authorUserId,
      body: this.body,
      quoteText: this.quoteText,
      createdAt: this.createdAt,
    };
  }
}
