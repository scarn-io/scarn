import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreError, ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import { workItemCommentEntityToContract } from "./work-item-comment-contract-mapper";
import type { WorkItemCommentRepo } from "./work-item-comment-repo";
import {
  editWorkItemCommentInputSchema,
  type EditWorkItemCommentInput,
  type WorkItemCommentContract,
} from "../contracts/work-item-comment-contracts";
import { parseWorkItemCommentId } from "../domain/work-item-comment-id";

export type EditWorkItemCommentDeps = {
  userAuthz: UserAuthorizationService;
  workItemCommentRepo: WorkItemCommentRepo;
  usernameReader: UsernameReader;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor | undefined;
};

export const editWorkItemComment = async (
  input: EditWorkItemCommentInput,
  deps: EditWorkItemCommentDeps,
): Promise<WorkItemCommentContract> => {
  const {
    userAuthz,
    workItemCommentRepo,
    usernameReader,
    timeProvider,
    dbExecutor,
  } = deps;
  const parsedInput = editWorkItemCommentInputSchema.parse(input);
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

  if (
    comment.authorUserId === null ||
    comment.authorUserId !== userAuthz.actorId
  ) {
    throw new CoreError({
      code: "PROJECT_FORBIDDEN",
      message: `User ${userAuthz.actorId} may only edit their own comments`,
      status: 403,
    });
  }

  const edited = comment.edit(parsedInput.body, timeProvider.now());
  const persisted = await workItemCommentRepo.save(edited, dbExecutor);
  // The ownership guard above already proved this comment is user-authored
  // (non-null `authorUserId`), but `persisted` is a distinct object returned
  // from the repo, so TypeScript can't carry that narrowing across the
  // `save()` call — filter null-safely for consistency with
  // `list-work-item-comments.ts`/`create-work-item-comment.ts`.
  const usernamesByUserId = await usernameReader.loadUsernamesByUserId(
    [persisted.authorUserId].filter((id) => id !== null),
    dbExecutor,
  );
  const author = persisted.authorUserId
    ? usernamesByUserId.get(persisted.authorUserId)
    : undefined;
  return workItemCommentEntityToContract(persisted, {
    authorUsername: author?.username ?? null,
    authorImage: author?.image ?? null,
    authorName: null,
  });
};
