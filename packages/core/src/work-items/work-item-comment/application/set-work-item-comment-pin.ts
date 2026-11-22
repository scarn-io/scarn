import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import type { CommentTaskNameReader } from "./comment-task-name-reader";
import { workItemCommentToContract } from "./work-item-comment-contract-mapper";
import type { WorkItemCommentRepo } from "./work-item-comment-repo";
import {
  setWorkItemCommentPinInputSchema,
  type SetWorkItemCommentPinInput,
  type WorkItemCommentContract,
} from "../contracts/work-item-comment-contracts";
import { parseWorkItemCommentId } from "../domain/work-item-comment-id";

type SetWorkItemCommentPinDeps = {
  userAuthz: UserAuthorizationService;
  workItemCommentRepo: WorkItemCommentRepo;
  usernameReader: UsernameReader;
  commentTaskNameReader: CommentTaskNameReader;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor | undefined;
};

export const setWorkItemCommentPin = async (
  input: SetWorkItemCommentPinInput,
  deps: SetWorkItemCommentPinDeps,
): Promise<WorkItemCommentContract> => {
  const { userAuthz, workItemCommentRepo, timeProvider, dbExecutor } = deps;
  const parsedInput = setWorkItemCommentPinInputSchema.parse(input);
  const commentId = parseWorkItemCommentId(parsedInput.commentId);

  const comment = await workItemCommentRepo.load(commentId, dbExecutor);
  if (!comment) {
    throw new ResourceNotFoundError("Work item comment", commentId);
  }

  await userAuthz.requireProjectPermission({
    projectId: comment.projectId,
    permission: "comments:update",
    dbExecutor,
  });

  const updated = comment.setPinned(parsedInput.isPinned, timeProvider.now());
  const persisted = await workItemCommentRepo.save(updated, dbExecutor);
  return await workItemCommentToContract(persisted, deps, dbExecutor);
};
