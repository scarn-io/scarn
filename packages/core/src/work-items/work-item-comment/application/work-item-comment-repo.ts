import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { WorkItemCommentEntity } from "../domain/work-item-comment-entity";
import type { WorkItemCommentId } from "../domain/work-item-comment-id";

export type WorkItemCommentPage = {
  items: WorkItemCommentEntity[];
  totalCount: number;
  nextCursor: string | null;
};

export type WorkItemCommentRepo = {
  loadPageByWorkItemId(
    workItemId: UuidV7,
    cursor?: string,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemCommentPage>;
  create(
    comment: WorkItemCommentEntity,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemCommentEntity>;
  load(
    id: WorkItemCommentId,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemCommentEntity | null>;
  loadByWorkItemId(
    workItemId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemCommentEntity[]>;
  loadPinnedByWorkItemId(
    workItemId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemCommentEntity[]>;
  save(
    comment: WorkItemCommentEntity,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemCommentEntity>;
  delete(id: WorkItemCommentId, dbExecutor?: DbExecutor): Promise<number>;
};
