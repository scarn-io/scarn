import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { ConversationEntity } from "../domain/conversation-entity";
import type { ConversationMessageEntity } from "../domain/conversation-message-entity";

export type WorkItemConversationSummary = {
  conversation: ConversationEntity;
  lastMessageAt: Date | null;
};

export type ConversationRepo = {
  load(id: UuidV7, dbExecutor?: DbExecutor): Promise<ConversationEntity | null>;
  /** Loads the row `FOR UPDATE`; status changes go through this. */
  lock(id: UuidV7, dbExecutor: DbExecutor): Promise<ConversationEntity | null>;
  create(
    conversation: ConversationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<ConversationEntity>;
  save(
    conversation: ConversationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<ConversationEntity>;
  /** Deletes the conversation and, by cascade, its messages. */
  delete(id: UuidV7, dbExecutor: DbExecutor): Promise<void>;
  insertMessage(
    message: ConversationMessageEntity,
    dbExecutor?: DbExecutor,
  ): Promise<ConversationMessageEntity>;
  /** The conversation holding the agent message `taskRunId` wrote, if any. */
  findIdByAgentTaskRunId(
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<UuidV7 | null>;
  /** Every message, oldest first. */
  listMessages(
    conversationId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ConversationMessageEntity[]>;
  /** The conversations' messages, oldest first, in one query. */
  listMessagesByConversationIds(
    conversationIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ): Promise<ConversationMessageEntity[]>;
  /** Person and system messages not yet delivered to an attempt, oldest first. */
  listUndeliveredInbound(
    conversationId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<ConversationMessageEntity[]>;
  markDelivered(
    messageIds: readonly UuidV7[],
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<void>;
  /** The work item's conversations, newest first, with their last message time. */
  listByWorkItemId(
    workItemId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemConversationSummary[]>;
};
