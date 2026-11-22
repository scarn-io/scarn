import { and, eq, inArray } from "drizzle-orm";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { taskExecutionConfigs } from "@scarn/core/lib/db/schema";
import { PersistenceError } from "@scarn/core/lib/errors";
import type { TaskExecutionConfigRepo } from "../application/task-execution-config-repo";
import {
  CURRENT_TASK_EXECUTION_CONFIG_SCHEMA_VERSION,
  readStoredTaskExecutionConfig,
  type StoredTaskExecutionConfigColumns,
} from "../contracts/task-execution-config-stored";
import { TaskExecutionConfigEntity } from "../domain/task-execution-config-entity";

type TaskExecutionConfigRow = Omit<
  typeof taskExecutionConfigs.$inferSelect,
  "environmentJson"
> &
  StoredTaskExecutionConfigColumns;

/**
 * Reads the row's JSON through its version's stored schema and the converter
 * chain (D6). A row that does not parse is a persistence fault, not a
 * validation error: it was written by this code.
 */
export const taskExecutionConfigFromRow = (
  row: TaskExecutionConfigRow,
): TaskExecutionConfigEntity => {
  const read = readStoredTaskExecutionConfig(row.schemaVersion, row);
  if (!read.success) {
    throw new PersistenceError(
      `task execution config ${row.id} is unreadable: ${read.reason}`,
      "TASK_EXECUTION_CONFIG_ROW_UNREADABLE",
    );
  }

  return TaskExecutionConfigEntity.rehydrate({
    id: parseUuidV7(row.id),
    projectId: parseUuidV7(row.projectId),
    content: read.content,
    createdAt: row.createdAt,
  });
};

const toRow = (
  config: TaskExecutionConfigEntity,
): typeof taskExecutionConfigs.$inferInsert => ({
  id: config.id,
  projectId: config.projectId,
  schemaVersion: CURRENT_TASK_EXECUTION_CONFIG_SCHEMA_VERSION,
  contentHash: config.contentHash(),
  environmentJson: config.environment,
  gitJson: config.git,
  mcpJson: config.mcp,
  healthChecksJson: config.healthChecks,
  createdAt: config.createdAt ?? new Date(),
});

export class DrizzleTaskExecutionConfigRepo implements TaskExecutionConfigRepo {
  async load(id: UuidV7, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(taskExecutionConfigs)
      .where(eq(taskExecutionConfigs.id, id))
      .limit(1);

    return row ? taskExecutionConfigFromRow(row) : null;
  }

  async loadMany(ids: UuidV7[], dbExecutor?: DbExecutor) {
    if (ids.length === 0) return [];
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(taskExecutionConfigs)
      .where(inArray(taskExecutionConfigs.id, ids));

    return rows.map(taskExecutionConfigFromRow);
  }

  async findOrCreate(
    config: TaskExecutionConfigEntity,
    dbExecutor?: DbExecutor,
  ) {
    const db = dbExecutor ?? getDb();
    const row = toRow(config);

    await db
      .insert(taskExecutionConfigs)
      .values(row)
      .onConflictDoNothing({
        target: [
          taskExecutionConfigs.projectId,
          taskExecutionConfigs.contentHash,
        ],
      });

    const [stored] = await db
      .select()
      .from(taskExecutionConfigs)
      .where(
        and(
          eq(taskExecutionConfigs.projectId, row.projectId),
          eq(taskExecutionConfigs.contentHash, row.contentHash),
        ),
      )
      .limit(1);

    if (!stored) {
      throw new PersistenceError(
        `Failed to find or create task execution config ${config.id}`,
        "TASK_EXECUTION_CONFIG_CREATE_FAILED",
      );
    }

    return taskExecutionConfigFromRow(stored);
  }
}
