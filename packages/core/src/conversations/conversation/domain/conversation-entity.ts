import {
  createUuidV7,
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { CoreError } from "@scarn/core/lib/errors";
import { normalizeDate } from "@scarn/core/work-items/work-item/domain/date-utils";

/**
 * `agent_turn`: the agent has the floor. `waiting_for_person`: the agent
 * ended its turn and waits for a reply. `reply_pending`: a person replied
 * and the agent's next turn is queued; more messages join it until it is
 * delivered. `closed`: the step visit ended.
 */
export const conversationStatusValues = [
  "agent_turn",
  "waiting_for_person",
  "reply_pending",
  "closed",
] as const;

export type ConversationStatus = (typeof conversationStatusValues)[number];

/** An ended chat can't be retried or reopened (409). */
export class ConversationEndedError extends CoreError {
  constructor(conversationId: string) {
    super({
      code: "CONVERSATION_ENDED",
      message: `Conversation ${conversationId} has ended`,
      status: 409,
      meta: { conversationId },
    });
  }
}

/** A failed chat takes no replies until it is retried (409). */
export class ConversationTaskFailedError extends CoreError {
  constructor(conversationId: string) {
    super({
      code: "CONVERSATION_TASK_FAILED",
      message: `Conversation ${conversationId}'s last turn failed; retry it before replying`,
      status: 409,
      meta: { conversationId },
    });
  }
}

/** A person can only add to a conversation that waits for them (409). */
export class ConversationNotWaitingError extends CoreError {
  constructor(conversationId: string, status: ConversationStatus) {
    super({
      code: "CONVERSATION_NOT_WAITING",
      message: `Conversation ${conversationId} isn't waiting for a person (status: ${status})`,
      status: 409,
      meta: { conversationId, status },
    });
  }
}

export type ConversationEntityProps = {
  id: UuidV7;
  projectId: UuidV7;
  /** Null for a conversation that isn't on a work item. */
  workItemId: UuidV7 | null;
  status: ConversationStatus;
  createdAt?: Date | string | null | undefined;
  updatedAt?: Date | string | null | undefined;
  closedAt?: Date | string | null | undefined;
};

/**
 * A conversation between an agent and people. It knows nothing of pipeline
 * runs: a step visit points at its conversation.
 */
export class ConversationEntity {
  public readonly id: UuidV7;
  public readonly projectId: UuidV7;
  public readonly workItemId: UuidV7 | null;
  public readonly status: ConversationStatus;
  public readonly createdAt: Date | null | undefined;
  public readonly updatedAt: Date | null | undefined;
  public readonly closedAt: Date | null | undefined;

  private constructor(props: ConversationEntityProps) {
    this.id = parseUuidV7(props.id);
    this.projectId = parseUuidV7(props.projectId);
    this.workItemId =
      props.workItemId === null ? null : parseUuidV7(props.workItemId);
    this.status = props.status;
    this.createdAt = normalizeDate(props.createdAt);
    this.updatedAt = normalizeDate(props.updatedAt);
    this.closedAt = normalizeDate(props.closedAt);
  }

  /** A conversation the agent opens by ending its first turn, waiting for a person. */
  static start(props: {
    id?: UuidV7 | undefined;
    projectId: UuidV7;
    workItemId: UuidV7 | null;
    now: Date;
  }): ConversationEntity {
    return new ConversationEntity({
      id: props.id ?? createUuidV7(),
      projectId: props.projectId,
      workItemId: props.workItemId,
      status: "waiting_for_person",
      createdAt: props.now,
      updatedAt: props.now,
      closedAt: null,
    });
  }

  /**
   * A repo conversation a person opens with their first question: no work
   * item, and the agent's first turn is queued (`reply_pending`).
   */
  static open(props: {
    id?: UuidV7 | undefined;
    projectId: UuidV7;
    now: Date;
  }): ConversationEntity {
    return new ConversationEntity({
      id: props.id ?? createUuidV7(),
      projectId: props.projectId,
      workItemId: null,
      status: "reply_pending",
      createdAt: props.now,
      updatedAt: props.now,
      closedAt: null,
    });
  }

  static rehydrate(props: ConversationEntityProps): ConversationEntity {
    return new ConversationEntity(props);
  }

  get isClosed(): boolean {
    return this.status === "closed";
  }

  /** The agent ended its turn: the floor passes to a person. */
  awaitPerson(now: Date): ConversationEntity {
    if (this.isClosed) {
      throw new ConversationNotWaitingError(this.id, this.status);
    }
    return this.withStatus("waiting_for_person", now);
  }

  /**
   * A person's message, accepted until the agent's next turn is delivered.
   * The first one moves `waiting_for_person` to `reply_pending`.
   */
  acceptPersonMessage(now: Date): ConversationEntity {
    if (
      this.status !== "waiting_for_person" &&
      this.status !== "reply_pending"
    ) {
      throw new ConversationNotWaitingError(this.id, this.status);
    }
    return this.withStatus("reply_pending", now);
  }

  /**
   * A person acts without writing (continues without a reply, or ends the
   * conversation); only while the agent waits for them.
   */
  assertWaitingForPerson(): void {
    if (this.status !== "waiting_for_person") {
      throw new ConversationNotWaitingError(this.id, this.status);
    }
  }

  /** The pending messages reached the agent: it has the floor again. */
  deliver(now: Date): ConversationEntity {
    return this.isClosed ? this : this.withStatus("agent_turn", now);
  }

  close(now: Date): ConversationEntity {
    if (this.isClosed) {
      return this;
    }
    return new ConversationEntity({
      ...this.toJSON(),
      status: "closed",
      updatedAt: now,
      closedAt: now,
    });
  }

  /**
   * A fresh attempt at the owning Task gives the agent the floor again. A
   * conversation whose turn is still `reply_pending` (a chat that failed
   * before its messages were delivered) keeps them pending for the retry.
   */
  reopenForRetry(now: Date): ConversationEntity {
    return new ConversationEntity({
      ...this.toJSON(),
      status: this.status === "reply_pending" ? "reply_pending" : "agent_turn",
      updatedAt: now,
      closedAt: null,
    });
  }

  private withStatus(status: ConversationStatus, now: Date) {
    return new ConversationEntity({ ...this.toJSON(), status, updatedAt: now });
  }

  toJSON(): ConversationEntityProps {
    return {
      id: this.id,
      projectId: this.projectId,
      workItemId: this.workItemId,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      closedAt: this.closedAt,
    };
  }
}
