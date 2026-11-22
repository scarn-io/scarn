import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import {
  createWorkItemCommentInputToProps,
  workItemCommentEntityToContract,
} from "./work-item-comment-contract-mapper";
import type { WorkItemCommentRepo } from "./work-item-comment-repo";
import {
  createWorkItemCommentInputSchema,
  type CreateWorkItemCommentInput,
  type WorkItemCommentContract,
} from "../contracts/work-item-comment-contracts";
import { WorkItemCommentEntity } from "../domain/work-item-comment-entity";

export type CreateWorkItemCommentDeps = {
  userAuthz: UserAuthorizationService;
  workItemRepo: WorkItemRepo;
  workItemCommentRepo: WorkItemCommentRepo;
  usernameReader: UsernameReader;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor | undefined;
};

export const createWorkItemComment = async (
  input: CreateWorkItemCommentInput,
  deps: CreateWorkItemCommentDeps,
): Promise<WorkItemCommentContract> => {
  const {
    userAuthz,
    workItemRepo,
    workItemCommentRepo,
    usernameReader,
    timeProvider,
    dbExecutor,
  } = deps;
  const parsedInput = createWorkItemCommentInputSchema.parse(input);

  const workItemId = parseWorkItemId(parsedInput.workItemId);
  const workItem = await workItemRepo.load(workItemId, dbExecutor);
  if (!workItem) {
    throw new ResourceNotFoundError("Work item", workItemId);
  }

  await userAuthz.requireProjectPermission({
    projectId: workItem.projectId,
    permission: "comments:create",
    dbExecutor,
  });

  if (parsedInput.parentCommentId) {
    WorkItemCommentEntity.assertValidParent(
      await workItemCommentRepo.load(parsedInput.parentCommentId, dbExecutor),
      workItem.id,
    );
  }

  const now = timeProvider.now();
  const comment = WorkItemCommentEntity.rehydrate({
    ...WorkItemCommentEntity.create(
      createWorkItemCommentInputToProps(parsedInput, {
        projectId: workItem.projectId,
        authorUserId: userAuthz.actorId,
      }),
    ).toJSON(),
    createdAt: now,
    updatedAt: now,
  });

  const persisted = await workItemCommentRepo.create(comment, dbExecutor);
  // `createWorkItemComment` only ever produces user-authored comments, so
  // `persisted.authorUserId` is always non-null here — but the entity types
  // it as nullable (agent-authored comments share the same shape), so filter
  // consistently with `list-work-item-comments.ts`/`set-work-item-comment-pin.ts`.
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
