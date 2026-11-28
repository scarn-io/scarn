import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import { normalizeDate } from "@scarn/core/work-items/work-item/domain/date-utils";

export const CONVERSATION_MESSAGE_BODY_MAX_LENGTH = 20_000;

/**
 * `agent`: an agent's final message when it ended its turn. `person`: what a
 * person wrote. `system`: an action a person took without writing ("Alex
 * chose to continue without a reply").
 */
export const conversationMessageAuthorKindValues = [
  "agent",
  "person",
  "system",
] as const;

export type ConversationMessageAuthorKind =
  (typeof conversationMessageAuthorKindValues)[number];

export type ConversationMessageEntityProps = {
  id: UuidV7;
  conversationId: UuidV7;
  authorKind: ConversationMessageAuthorKind;
  /** Null for an agent message; the acting person otherwise. */
  authorUserId: UuidV7 | null;
  /** The attempt that wrote an agent message. */
  taskRunId: UuidV7 | null;
  /** The attempt a person or system message was delivered into. */
  deliveredToTaskRunId: UuidV7 | null;
  /**
   * The grant request an agent message carries, or whose decision a system
   * message records; omitted means none.
   */
  grantRequestId?: UuidV7 | null | undefined;
  body: string;
  createdAt?: Date | string | null | undefined;
};

type NewMessageProps = {
  id?: UuidV7 | undefined;
  conversationId: UuidV7;
  body: string;
  grantRequestId?: UuidV7 | null | undefined;
  createdAt?: Date | undefined;
};

export class ConversationMessageEntity {
  public readonly id: UuidV7;
  public readonly conversationId: UuidV7;
  public readonly authorKind: ConversationMessageAuthorKind;
  public readonly authorUserId: UuidV7 | null;
  public readonly taskRunId: UuidV7 | null;
  public readonly deliveredToTaskRunId: UuidV7 | null;
  public readonly grantRequestId: UuidV7 | null;
  public readonly body: string;
  public readonly createdAt: Date | null | undefined;

  private constructor(props: ConversationMessageEntityProps) {
    const body = props.body.trim();
    if (!body) {
      throw new CoreValidationError(
        "Conversation message body is required",
        "CONVERSATION_MESSAGE_BODY_REQUIRED",
      );
    }
    if (body.length > CONVERSATION_MESSAGE_BODY_MAX_LENGTH) {
      throw new CoreValidationError(
        `Conversation message body must be at most ${String(CONVERSATION_MESSAGE_BODY_MAX_LENGTH)} characters`,
        "CONVERSATION_MESSAGE_BODY_TOO_LONG",
      );
    }
    if ((props.authorKind === "agent") !== (props.authorUserId === null)) {
      throw new CoreValidationError(
        "Only an agent message has no author user",
        "CONVERSATION_MESSAGE_AUTHOR_INVALID",
      );
    }

    this.id = parseUuidV7(props.id);
    this.conversationId = parseUuidV7(props.conversationId);
    this.authorKind = props.authorKind;
    this.authorUserId =
      props.authorUserId === null ? null : parseUuidV7(props.authorUserId);
    this.taskRunId =
      props.taskRunId === null ? null : parseUuidV7(props.taskRunId);
    this.deliveredToTaskRunId =
      props.deliveredToTaskRunId === null
        ? null
        : parseUuidV7(props.deliveredToTaskRunId);
    this.grantRequestId =
      props.grantRequestId == null ? null : parseUuidV7(props.grantRequestId);
    this.body = body;
    this.createdAt = normalizeDate(props.createdAt);
  }

  static agent(
    props: NewMessageProps & { taskRunId: UuidV7 },
  ): ConversationMessageEntity {
    return new ConversationMessageEntity({
      id: props.id ?? createUuidV7(),
      conversationId: props.conversationId,
      authorKind: "agent",
      authorUserId: null,
      taskRunId: props.taskRunId,
      deliveredToTaskRunId: null,
      grantRequestId: props.grantRequestId,
      body: props.body,
      createdAt: props.createdAt,
    });
  }

  static person(
    props: NewMessageProps & { authorUserId: UuidV7 },
  ): ConversationMessageEntity {
    return ConversationMessageEntity.inbound("person", props);
  }

  static system(
    props: NewMessageProps & { authorUserId: UuidV7 },
  ): ConversationMessageEntity {
    return ConversationMessageEntity.inbound("system", props);
  }

  private static inbound(
    authorKind: "person" | "system",
    props: NewMessageProps & { authorUserId: UuidV7 },
  ) {
    return new ConversationMessageEntity({
      id: props.id ?? createUuidV7(),
      conversationId: props.conversationId,
      authorKind,
      authorUserId: props.authorUserId,
      taskRunId: null,
      deliveredToTaskRunId: null,
      grantRequestId: props.grantRequestId,
      body: props.body,
      createdAt: props.createdAt,
    });
  }

  static rehydrate(
    props: ConversationMessageEntityProps,
  ): ConversationMessageEntity {
    return new ConversationMessageEntity(props);
  }

  toJSON(): ConversationMessageEntityProps {
    return {
      id: this.id,
      conversationId: this.conversationId,
      authorKind: this.authorKind,
      authorUserId: this.authorUserId,
      taskRunId: this.taskRunId,
      deliveredToTaskRunId: this.deliveredToTaskRunId,
      grantRequestId: this.grantRequestId,
      body: this.body,
      createdAt: this.createdAt,
    };
  }
}
