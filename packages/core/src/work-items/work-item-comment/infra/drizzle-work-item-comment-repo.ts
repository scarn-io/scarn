import { and, asc, count, desc, eq, getColumns, sql } from "drizzle-orm";
import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { PersistenceError } from "@scarn/core/lib/errors";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { workItemComments } from "@scarn/core/lib/db/schema";
import type {
  WorkItemCommentPage,
  WorkItemCommentRepo,
} from "../application/work-item-comment-repo";
import { TASK_RUN_WORK_ITEM_COMMENTS_PAGE_SIZE } from "@scarn/core/tasks/task-run/contracts/task-run-work-item-contracts";
import {
  decodeWorkItemCommentPageCursor,
  encodeWorkItemCommentPageCursor,
} from "../application/work-item-comment-page-cursor";
import {
  WorkItemCommentEntity,
  type WorkItemCommentEntityProps,
} from "../domain/work-item-comment-entity";
import {
  parseWorkItemCommentId,
  type WorkItemCommentId,
} from "../domain/work-item-comment-id";

const toWorkItemCommentRow = (comment: WorkItemCommentEntity) => ({
  id: comment.id,
  projectId: comment.projectId,
  workItemId: comment.workItemId,
  authorUserId: comment.authorUserId,
  authorKind: comment.authorKind,
  agentSessionId: comment.agentSessionId,
  sourceNotificationId: comment.sourceNotificationId,
  externalCommentId: comment.externalCommentId,
  externalCommentUrl: comment.externalCommentUrl,
  authoredByTaskId: comment.authoredByTaskId,
  parentCommentId: comment.parentCommentId,
  body: comment.body,
  isPinned: comment.isPinned,
  createdAt: comment.createdAt ?? new Date(),
  updatedAt: comment.updatedAt ?? new Date(),
});

export class DrizzleWorkItemCommentRepo implements WorkItemCommentRepo {
  async loadPageByWorkItemId(
    workItemId: UuidV7,
    cursor?: string,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemCommentPage> {
    const db = dbExecutor ?? getDb();
    const after =
      cursor === undefined
        ? undefined
        : decodeWorkItemCommentPageCursor(cursor, workItemId);
    const [rows, totals] = await Promise.all([
      db
        .select({
          ...getColumns(workItemComments),
          cursorCreatedAt: sql<string>`to_char(${workItemComments.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(workItemComments)
        .where(
          and(
            eq(workItemComments.workItemId, workItemId),
            after
              ? sql`(${workItemComments.isPinned}, ${workItemComments.createdAt}, ${workItemComments.id}) < (${after.isPinned}::boolean, ${after.createdAt}::timestamptz, ${after.id}::uuid)`
              : undefined,
          ),
        )
        .orderBy(
          desc(workItemComments.isPinned),
          desc(workItemComments.createdAt),
          desc(workItemComments.id),
        )
        .limit(TASK_RUN_WORK_ITEM_COMMENTS_PAGE_SIZE + 1),
      db
        .select({ totalCount: count() })
        .from(workItemComments)
        .where(eq(workItemComments.workItemId, workItemId)),
    ]);
    const pageRows = rows.slice(0, TASK_RUN_WORK_ITEM_COMMENTS_PAGE_SIZE);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map((row) => this.toEntity(row)),
      totalCount: totals[0]?.totalCount ?? 0,
      nextCursor:
        rows.length > TASK_RUN_WORK_ITEM_COMMENTS_PAGE_SIZE && last
          ? encodeWorkItemCommentPageCursor({
              version: 1,
              workItemId,
              isPinned: last.isPinned,
              createdAt: last.cursorCreatedAt,
              id: last.id as UuidV7,
            })
          : null,
    };
  }

  private toEntity(
    row: typeof workItemComments.$inferSelect,
  ): WorkItemCommentEntity {
    return WorkItemCommentEntity.rehydrate({
      id: parseWorkItemCommentId(row.id),
      projectId: row.projectId as UuidV7,
      workItemId: row.workItemId as UuidV7,
      authorUserId: row.authorUserId as UuidV7 | null,
      authorKind: row.authorKind,
      agentSessionId: row.agentSessionId as UuidV7 | null,
      sourceNotificationId: row.sourceNotificationId as UuidV7 | null,
      externalCommentId: row.externalCommentId,
      externalCommentUrl: row.externalCommentUrl,
      authoredByTaskId: row.authoredByTaskId as UuidV7 | null,
      parentCommentId: row.parentCommentId
        ? parseWorkItemCommentId(row.parentCommentId)
        : null,
      body: row.body,
      isPinned: row.isPinned,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } satisfies WorkItemCommentEntityProps);
  }

  async create(
    comment: WorkItemCommentEntity,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemCommentEntity> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(workItemComments)
      .values(toWorkItemCommentRow(comment))
      .returning();

    if (!row) {
      throw new PersistenceError(
        `Failed to create work item comment ${comment.id}`,
        "WORK_ITEM_COMMENT_CREATE_FAILED",
      );
    }

    return this.toEntity(row);
  }

  async load(
    id: WorkItemCommentId,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemCommentEntity | null> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .select()
      .from(workItemComments)
      .where(eq(workItemComments.id, id))
      .limit(1);

    return row ? this.toEntity(row) : null;
  }

  async loadByWorkItemId(
    workItemId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemCommentEntity[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(workItemComments)
      .where(eq(workItemComments.workItemId, workItemId))
      .orderBy(asc(workItemComments.createdAt), asc(workItemComments.id));

    return rows.map((row) => this.toEntity(row));
  }

  async loadPinnedByWorkItemId(
    workItemId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemCommentEntity[]> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .select()
      .from(workItemComments)
      .where(
        and(
          eq(workItemComments.workItemId, workItemId),
          eq(workItemComments.isPinned, true),
        ),
      )
      .orderBy(asc(workItemComments.createdAt), asc(workItemComments.id));

    return rows.map((row) => this.toEntity(row));
  }

  async save(
    comment: WorkItemCommentEntity,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemCommentEntity> {
    const db = dbExecutor ?? getDb();
    const [row] = await db
      .insert(workItemComments)
      .values(toWorkItemCommentRow(comment))
      .onConflictDoUpdate({
        target: [workItemComments.id],
        set: {
          body: comment.body,
          isPinned: comment.isPinned,
          updatedAt: comment.updatedAt ?? new Date(),
        },
      })
      .returning();

    if (!row) {
      throw new PersistenceError(
        `Failed to save work item comment ${comment.id}`,
        "WORK_ITEM_COMMENT_SAVE_FAILED",
      );
    }

    return this.toEntity(row);
  }

  async delete(
    id: WorkItemCommentId,
    dbExecutor?: DbExecutor,
  ): Promise<number> {
    const db = dbExecutor ?? getDb();
    const rows = await db
      .delete(workItemComments)
      .where(eq(workItemComments.id, id))
      .returning({ id: workItemComments.id });

    return rows.length;
  }
}
