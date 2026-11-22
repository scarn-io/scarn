import { and, asc, desc, eq, inArray, isNull, max, ne } from "drizzle-orm";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { conversationMessages, conversations } from "@scarn/core/lib/db/schema";
import { PersistenceError } from "@scarn/core/lib/errors";
import type {
  ConversationRepo,
  WorkItemConversationSummary,
} from "../application/conversation-repo";
import { ConversationEntity } from "../domain/conversation-entity";
import { ConversationMessageEntity } from "../domain/conversation-message-entity";

type ConversationRow = typeof conversations.$inferSelect;
type ConversationMessageRow = typeof conversationMessages.$inferSelect;

const toEntity = (row: ConversationRow): ConversationEntity =>
  ConversationEntity.rehydrate({
    id: row.id as UuidV7,
    projectId: row.projectId as UuidV7,
    workItemId: row.workItemId as UuidV7 | null,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt,
  });

const toRow = (conversation: ConversationEntity) => ({
  id: conversation.id,
  projectId: conversation.projectId,
  workItemId: conversation.workItemId,
  status: conversation.status,
  createdAt: conversation.createdAt ?? new Date(),
  updatedAt: conversation.updatedAt ?? new Date(),
  closedAt: conversation.closedAt ?? null,
});

const toMessageEntity = (
  row: ConversationMessageRow,
): ConversationMessageEntity =>
  ConversationMessageEntity.rehydrate({
    id: row.id as UuidV7,
    conversationId: row.conversationId as UuidV7,
    authorKind: row.authorKind,
    authorUserId: row.authorUserId as UuidV7 | null,
    taskRunId: row.taskRunId as UuidV7 | null,
    deliveredToTaskRunId: row.deliveredToTaskRunId as UuidV7 | null,
    body: row.body,
    createdAt: row.createdAt,
  });

const toMessageRow = (message: ConversationMessageEntity) => ({
  id: message.id,
  conversationId: message.conversationId,
  authorKind: message.authorKind,
  authorUserId: message.authorUserId,
  taskRunId: message.taskRunId,
  deliveredToTaskRunId: message.deliveredToTaskRunId,
  body: message.body,
  createdAt: message.createdAt ?? new Date(),
});

export class DrizzleConversationRepo implements ConversationRepo {
  async load(id: UuidV7, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    return row ? toEntity(row) : null;
  }

  async lock(id: UuidV7, dbExecutor: DbExecutor) {
    const [row] = await dbExecutor
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1)
      .for("update");
    return row ? toEntity(row) : null;
  }

  async create(conversation: ConversationEntity, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(conversations)
      .values(toRow(conversation))
      .returning();
    if (!row) {
      throw new PersistenceError(
        `Failed to create conversation ${conversation.id}`,
        "CONVERSATION_CREATE_FAILED",
      );
    }
    return toEntity(row);
  }

  async save(conversation: ConversationEntity, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    const { status, updatedAt, closedAt } = toRow(conversation);
    const [row] = await db
      .update(conversations)
      .set({ status, updatedAt, closedAt })
      .where(eq(conversations.id, conversation.id))
      .returning();
    if (!row) {
      throw new PersistenceError(
        `Failed to save conversation ${conversation.id}`,
        "CONVERSATION_SAVE_FAILED",
      );
    }
    return toEntity(row);
  }

  async delete(id: UuidV7, dbExecutor: DbExecutor) {
    await dbExecutor.delete(conversations).where(eq(conversations.id, id));
  }

  async insertMessage(
    message: ConversationMessageEntity,
    dbExecutor?: DbExecutor,
  ) {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(conversationMessages)
      .values(toMessageRow(message))
      .returning();
    if (!row) {
      throw new PersistenceError(
        `Failed to create conversation message ${message.id}`,
        "CONVERSATION_MESSAGE_CREATE_FAILED",
      );
    }
    return toMessageEntity(row);
  }

  async findIdByAgentTaskRunId(taskRunId: UuidV7, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select({ conversationId: conversationMessages.conversationId })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.taskRunId, taskRunId),
          eq(conversationMessages.authorKind, "agent"),
        ),
      )
      .limit(1);
    return row ? (row.conversationId as UuidV7) : null;
  }

  async listMessages(conversationId: UuidV7, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId))
      .orderBy(
        asc(conversationMessages.createdAt),
        asc(conversationMessages.id),
      );
    return rows.map(toMessageEntity);
  }

  async listMessagesByConversationIds(
    conversationIds: readonly UuidV7[],
    dbExecutor?: DbExecutor,
  ) {
    if (conversationIds.length === 0) {
      return [];
    }
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(conversationMessages)
      .where(inArray(conversationMessages.conversationId, [...conversationIds]))
      .orderBy(
        asc(conversationMessages.createdAt),
        asc(conversationMessages.id),
      );
    return rows.map(toMessageEntity);
  }

  async listUndeliveredInbound(
    conversationId: UuidV7,
    dbExecutor?: DbExecutor,
  ) {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, conversationId),
          ne(conversationMessages.authorKind, "agent"),
          isNull(conversationMessages.deliveredToTaskRunId),
        ),
      )
      .orderBy(
        asc(conversationMessages.createdAt),
        asc(conversationMessages.id),
      );
    return rows.map(toMessageEntity);
  }

  async markDelivered(
    messageIds: readonly UuidV7[],
    taskRunId: UuidV7,
    dbExecutor?: DbExecutor,
  ) {
    if (messageIds.length === 0) {
      return;
    }
    const db = dbExecutor ?? getDb();
    await db
      .update(conversationMessages)
      .set({ deliveredToTaskRunId: taskRunId })
      .where(inArray(conversationMessages.id, [...messageIds]));
  }

  async listByWorkItemId(
    workItemId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemConversationSummary[]> {
    const db = dbExecutor ?? getDb();
    const lastMessageAt = max(conversationMessages.createdAt);
    const rows = await db
      .select({ conversation: conversations, lastMessageAt })
      .from(conversations)
      .leftJoin(
        conversationMessages,
        eq(conversationMessages.conversationId, conversations.id),
      )
      .where(eq(conversations.workItemId, workItemId))
      .groupBy(conversations.id)
      .orderBy(desc(conversations.createdAt), desc(conversations.id));
    return rows.map((row) => ({
      conversation: toEntity(row.conversation),
      lastMessageAt: row.lastMessageAt ? new Date(row.lastMessageAt) : null,
    }));
  }
}
