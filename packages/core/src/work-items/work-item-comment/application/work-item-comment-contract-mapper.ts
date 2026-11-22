import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import type {
  CreateWorkItemCommentProps,
  WorkItemCommentEntity,
} from "../domain/work-item-comment-entity";
import {
  workItemCommentSchema,
  type CreateWorkItemCommentParsed,
  type WorkItemCommentContract,
} from "../contracts/work-item-comment-contracts";
import type { CommentTaskNameReader } from "./comment-task-name-reader";

export const createWorkItemCommentInputToProps = (
  input: CreateWorkItemCommentParsed,
  context: { projectId: UuidV7; authorUserId: UuidV7 },
): CreateWorkItemCommentProps => ({
  projectId: context.projectId,
  workItemId: parseUuidV7(input.workItemId),
  authorUserId: context.authorUserId,
  parentCommentId: input.parentCommentId ?? null,
  body: input.body,
});

export type CommentAuthorDisplay = {
  authorUsername: string | null;
  authorImage: string | null;
  authorName: string | null;
};

const NO_AUTHOR_DISPLAY: CommentAuthorDisplay = {
  authorUsername: null,
  authorImage: null,
  authorName: null,
};

export const workItemCommentEntityToContract = (
  comment: WorkItemCommentEntity,
  author: CommentAuthorDisplay = NO_AUTHOR_DISPLAY,
): WorkItemCommentContract =>
  workItemCommentSchema.parse({
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
    authorName: author.authorName,
    parentCommentId: comment.parentCommentId,
    authorUsername: author.authorUsername,
    authorImage: author.authorImage,
    body: comment.body,
    isPinned: comment.isPinned,
    createdAt: comment.createdAt?.toISOString() ?? null,
    updatedAt: comment.updatedAt?.toISOString() ?? null,
  });

export type CommentAuthorReaders = {
  usernameReader: UsernameReader;
  commentTaskNameReader: CommentTaskNameReader;
};

/**
 * Maps comments to contracts with their read-time author display fields: a
 * person's username and image from `authorUserId` (decision D4), an agent
 * Task's name from `authoredByTaskId`. Both are resolved in one batch each,
 * whatever the number of comments.
 */
export const workItemCommentsToContracts = async (
  comments: readonly WorkItemCommentEntity[],
  readers: CommentAuthorReaders,
  dbExecutor?: DbExecutor,
): Promise<WorkItemCommentContract[]> => {
  const [usersById, taskNamesById] = await Promise.all([
    readers.usernameReader.loadUsernamesByUserId(
      comments.flatMap((comment) =>
        comment.authorUserId ? [comment.authorUserId] : [],
      ),
      dbExecutor,
    ),
    readers.commentTaskNameReader.loadTaskNamesByTaskId(
      comments.flatMap((comment) =>
        comment.authoredByTaskId ? [comment.authoredByTaskId] : [],
      ),
      dbExecutor,
    ),
  ]);
  return comments.map((comment) => {
    const user = comment.authorUserId
      ? usersById.get(comment.authorUserId)
      : undefined;
    return workItemCommentEntityToContract(comment, {
      authorUsername: user?.username ?? null,
      authorImage: user?.image ?? null,
      authorName: comment.authoredByTaskId
        ? (taskNamesById.get(comment.authoredByTaskId) ?? null)
        : null,
    });
  });
};

export const workItemCommentToContract = async (
  comment: WorkItemCommentEntity,
  readers: CommentAuthorReaders,
  dbExecutor?: DbExecutor,
): Promise<WorkItemCommentContract> => {
  const [contract] = await workItemCommentsToContracts(
    [comment],
    readers,
    dbExecutor,
  );
  if (!contract) {
    throw new Error("Expected one mapped comment");
  }
  return contract;
};
