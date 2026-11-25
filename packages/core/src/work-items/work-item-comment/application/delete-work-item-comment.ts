import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { WorkItemCommentRepo } from "./work-item-comment-repo";
import {
  deleteWorkItemCommentInputSchema,
  type DeleteWorkItemCommentInput,
} from "../contracts/work-item-comment-contracts";
import { parseWorkItemCommentId } from "../domain/work-item-comment-id";

export type DeleteWorkItemCommentDeps = {
  userAuthz: UserAuthorizationService;
  workItemCommentRepo: WorkItemCommentRepo;
  dbExecutor?: DbExecutor | undefined;
};

export const deleteWorkItemComment = async (
  input: DeleteWorkItemCommentInput,
  deps: DeleteWorkItemCommentDeps,
): Promise<number> => {
  const { userAuthz, workItemCommentRepo, dbExecutor } = deps;
  const commentId = parseWorkItemCommentId(
    deleteWorkItemCommentInputSchema.parse(input),
  );

  const comment = await workItemCommentRepo.load(commentId, dbExecutor);
  if (!comment) {
    throw new ResourceNotFoundError("Work item comment", commentId);
  }

  if (comment.authorUserId !== userAuthz.actorId) {
    await userAuthz.requireProjectPermission({
      projectId: comment.projectId,
      permission: "comments:write",
      dbExecutor,
    });
  }

  return await workItemCommentRepo.delete(commentId, dbExecutor);
};
