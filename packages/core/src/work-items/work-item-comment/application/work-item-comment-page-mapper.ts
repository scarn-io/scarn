import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  agentWorkItemCommentsPageSchema,
  type AgentWorkItemCommentsPage,
} from "@scarn/core/tasks/task-run/contracts/task-run-work-item-contracts";
import { UNNAMED_AUTHOR_TASK_LABEL } from "./comment-task-name-reader";
import {
  workItemCommentsToContracts,
  type CommentAuthorReaders,
} from "./work-item-comment-contract-mapper";
import type { WorkItemCommentPage } from "./work-item-comment-repo";

export const workItemCommentPageToAgentContract = async (
  page: WorkItemCommentPage,
  readers: CommentAuthorReaders,
  dbExecutor?: DbExecutor,
): Promise<AgentWorkItemCommentsPage> => {
  const comments = await workItemCommentsToContracts(
    page.items,
    readers,
    dbExecutor,
  );
  return agentWorkItemCommentsPageSchema.parse({
    items: comments.map((comment) => ({
      id: comment.id,
      parentCommentId: comment.parentCommentId,
      body: comment.body,
      authorKind: comment.authorKind,
      authorName:
        comment.authorKind === "agent"
          ? comment.authorName?.trim() || UNNAMED_AUTHOR_TASK_LABEL
          : comment.authorUsername?.trim() || "User",
      isPinned: comment.isPinned,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    })),
    totalCount: page.totalCount,
    nextCursor: page.nextCursor,
  });
};
