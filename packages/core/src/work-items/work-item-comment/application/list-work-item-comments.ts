import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import type { CommentTaskNameReader } from "./comment-task-name-reader";
import { workItemCommentsToContracts } from "./work-item-comment-contract-mapper";
import type { WorkItemCommentRepo } from "./work-item-comment-repo";
import {
  listWorkItemCommentsInputSchema,
  type ListWorkItemCommentsInput,
  type WorkItemCommentContract,
} from "../contracts/work-item-comment-contracts";

type ListWorkItemCommentsDeps = {
  userAuthz: UserAuthorizationService;
  workItemRepo: WorkItemRepo;
  workItemCommentRepo: WorkItemCommentRepo;
  usernameReader: UsernameReader;
  commentTaskNameReader: CommentTaskNameReader;
  dbExecutor?: DbExecutor | undefined;
};

export const listWorkItemComments = async (
  input: ListWorkItemCommentsInput,
  deps: ListWorkItemCommentsDeps,
): Promise<WorkItemCommentContract[]> => {
  const {
    userAuthz,
    workItemRepo,
    workItemCommentRepo,
    usernameReader,
    commentTaskNameReader,
    dbExecutor,
  } = deps;
  const workItemId = parseWorkItemId(
    listWorkItemCommentsInputSchema.parse(input),
  );

  const workItem = await workItemRepo.load(workItemId, dbExecutor);
  if (!workItem) {
    throw new ResourceNotFoundError("Work item", workItemId);
  }

  await userAuthz.requireProjectPermission({
    projectId: workItem.projectId,
    permission: "comments:read",
    dbExecutor,
  });

  const comments = await workItemCommentRepo.loadByWorkItemId(
    parseUuidV7(workItemId),
    dbExecutor,
  );

  return await workItemCommentsToContracts(
    comments,
    { usernameReader, commentTaskNameReader },
    dbExecutor,
  );
};
