import { and, asc, eq } from "drizzle-orm";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { taskGrantRequests } from "@scarn/core/lib/db/schema";
import type { StoredReadResult } from "@scarn/core/lib/db/stored-json";
import { isUniqueViolation } from "@scarn/core/lib/db/unique-violation";
import { CoreError, PersistenceError } from "@scarn/core/lib/errors";
import type { GrantRequestRepo } from "../application/grant-request-repo";
import {
  CURRENT_GRANT_REQUEST_SCHEMA_VERSION,
  readStoredGrantRequest,
} from "../contracts/grant-request-stored";
import type { GrantRequest } from "../domain/grant-request";

type GrantRequestRow = typeof taskGrantRequests.$inferSelect;

const optionalUuid = (value: string | null): UuidV7 | null =>
  value === null ? null : parseUuidV7(value);

/** Reads a `task_grant_requests` row through `readStoredGrantRequest`. */
export const readGrantRequestRow = (
  row: GrantRequestRow,
): StoredReadResult<GrantRequest> => {
  const read = readStoredGrantRequest(row.schemaVersion, row);
  if (!read.success) {
    return read;
  }
  return {
    success: true,
    value: {
      id: parseUuidV7(row.id),
      projectId: parseUuidV7(row.projectId),
      taskId: parseUuidV7(row.taskId),
      taskRunId: parseUuidV7(row.taskRunId),
      reason: row.reason,
      requested: read.value.requested,
      status: row.status,
      approved: read.value.approved,
      note: row.note,
      decidedByUserId: optionalUuid(row.decidedByUserId),
      decidedAt: row.decidedAt,
      createdAt: row.createdAt,
    },
  };
};

const grantRequestRowToDomain = (row: GrantRequestRow): GrantRequest => {
  const read = readGrantRequestRow(row);
  if (!read.success) {
    throw new PersistenceError(
      `Grant request ${row.id} is unreadable: ${read.reason}`,
      "TASK_GRANT_REQUEST_ROW_UNREADABLE",
    );
  }
  return read.value;
};

const decisionColumns = (request: GrantRequest) => ({
  status: request.status,
  approvedJson: request.approved,
  note: request.note,
  decidedByUserId: request.decidedByUserId,
  decidedAt: request.decidedAt,
});

const alreadyPending = (request: GrantRequest) =>
  new CoreError({
    code: "GRANT_REQUEST_ALREADY_PENDING",
    message: `Task ${request.taskId} already has a pending grant request`,
    status: 409,
  });

export class DrizzleGrantRequestRepo implements GrantRequestRepo {
  async insert(
    request: GrantRequest,
    dbExecutor?: DbExecutor,
  ): Promise<GrantRequest> {
    const db = dbExecutor ?? getDb();
    let row: GrantRequestRow | undefined;
    try {
      [row] = await db
        .insert(taskGrantRequests)
        .values({
          id: request.id,
          projectId: request.projectId,
          taskId: request.taskId,
          taskRunId: request.taskRunId,
          reason: request.reason,
          requestedJson: request.requested,
          ...decisionColumns(request),
          schemaVersion: CURRENT_GRANT_REQUEST_SCHEMA_VERSION,
          createdAt: request.createdAt,
        })
        .returning();
    } catch (error) {
      if (isUniqueViolation(error as Error)) {
        throw alreadyPending(request);
      }
      throw error;
    }
    if (!row) {
      throw new PersistenceError(
        `Failed to insert grant request ${request.id}`,
        "TASK_GRANT_REQUEST_INSERT_FAILED",
      );
    }
    return grantRequestRowToDomain(row);
  }

  async load(id: UuidV7, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(taskGrantRequests)
      .where(eq(taskGrantRequests.id, id))
      .limit(1);
    return row ? grantRequestRowToDomain(row) : null;
  }

  async listByTaskId(taskId: UuidV7, dbExecutor?: DbExecutor) {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(taskGrantRequests)
      .where(eq(taskGrantRequests.taskId, taskId))
      .orderBy(asc(taskGrantRequests.createdAt), asc(taskGrantRequests.id));
    return rows.map(grantRequestRowToDomain);
  }

  async findPendingByTaskId(taskId: UuidV7, dbExecutor: DbExecutor) {
    const [row] = await dbExecutor
      .select()
      .from(taskGrantRequests)
      .where(
        and(
          eq(taskGrantRequests.taskId, taskId),
          eq(taskGrantRequests.status, "pending"),
        ),
      )
      .limit(1)
      .for("update");
    return row ? grantRequestRowToDomain(row) : null;
  }

  async save(
    request: GrantRequest,
    dbExecutor?: DbExecutor,
  ): Promise<GrantRequest> {
    const db = dbExecutor ?? getDb();
    let row: GrantRequestRow | undefined;
    try {
      [row] = await db
        .update(taskGrantRequests)
        .set(decisionColumns(request))
        .where(eq(taskGrantRequests.id, request.id))
        .returning();
    } catch (error) {
      if (isUniqueViolation(error as Error)) {
        throw alreadyPending(request);
      }
      throw error;
    }
    if (!row) {
      throw new PersistenceError(
        `Failed to save grant request ${request.id}`,
        "TASK_GRANT_REQUEST_SAVE_FAILED",
      );
    }
    return grantRequestRowToDomain(row);
  }
}
