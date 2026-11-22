import { asc, inArray } from "drizzle-orm";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { taskMessages } from "@scarn/core/lib/db/schema";
import { PersistenceError } from "@scarn/core/lib/errors";
import type { TaskMessageRepo } from "../application/task-message-repo";
import { TaskMessageEntity } from "../domain/task-message-entity";

type TaskMessageRow = typeof taskMessages.$inferSelect;

const toEntity = (row: TaskMessageRow): TaskMessageEntity =>
  TaskMessageEntity.rehydrate({
    id: row.id as UuidV7,
    taskId: row.taskId as UuidV7,
    authorUserId: row.authorUserId as UuidV7,
    body: row.body,
    quoteText: row.quoteText,
    createdAt: row.createdAt,
  });

const toRow = (taskMessage: TaskMessageEntity) => ({
  id: taskMessage.id,
  taskId: taskMessage.taskId,
  authorUserId: taskMessage.authorUserId,
  body: taskMessage.body,
  quoteText: taskMessage.quoteText,
  createdAt: taskMessage.createdAt ?? new Date(),
});

export class DrizzleTaskMessageRepo implements TaskMessageRepo {
  async create(taskMessage: TaskMessageEntity, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(taskMessages)
      .values(toRow(taskMessage))
      .returning();

    if (!row) {
      throw new PersistenceError(
        `Failed to create task message ${taskMessage.id}`,
        "TASK_MESSAGE_CREATE_FAILED",
      );
    }

    return toEntity(row);
  }

  async listByTaskIds(taskIds: readonly UuidV7[], dbExecutor?: DbExecutor) {
    if (taskIds.length === 0) {
      return [];
    }
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(taskMessages)
      .where(inArray(taskMessages.taskId, [...taskIds]))
      .orderBy(asc(taskMessages.createdAt), asc(taskMessages.id));

    return rows.map(toEntity);
  }
}
