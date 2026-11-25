import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import {
  CoreError,
  CoreValidationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { workItemEntityToContract } from "./work-item-contract-mapper";
import type { WorkItemRepo } from "./work-item-repo";
import {
  editWorkItemInputSchema,
  type EditWorkItemInput,
  type WorkItemContract,
} from "../contracts/work-item-contracts";
import type { WorkItemEntity } from "../domain/work-item-entity";
import { parseWorkItemId } from "../domain/work-item-id";

type EditWorkItemDeps = {
  userAuthz: UserAuthorizationService;
  workItemRepo: WorkItemRepo;
  projectRepo: Pick<ProjectRepo, "load">;
  usernameReader: UsernameReader;
  timeProvider: TimeProvider;
  dbExecutor?: DbExecutor | undefined;
};

const requireProjectMember = async (
  workItem: WorkItemEntity,
  userId: UuidV7,
  deps: EditWorkItemDeps,
): Promise<void> => {
  const project = await deps.projectRepo.load(
    workItem.projectId,
    deps.dbExecutor,
  );
  if (!project) {
    throw new ResourceNotFoundError("Project", workItem.projectId);
  }
  if (!project.getMembership(userId)) {
    throw new CoreValidationError(
      "A work item can only be assigned to a member of its project",
      "WORK_ITEM_ASSIGNEE_NOT_PROJECT_MEMBER",
    );
  }
};

const requireNativeAuthor = (workItem: WorkItemEntity, actorId: UuidV7) => {
  if (workItem.platform !== "scarn") {
    throw new CoreError({
      code: "WORK_ITEM_NOT_NATIVE",
      message:
        "This work item was synced from an external source and can't be edited here",
      status: 403,
    });
  }

  if (workItem.createdByUserId !== actorId) {
    throw new CoreError({
      code: "WORK_ITEM_NOT_AUTHOR",
      message: "Only the work item's author may edit it",
      status: 403,
    });
  }
};

export const editWorkItem = async (
  input: EditWorkItemInput,
  deps: EditWorkItemDeps,
): Promise<WorkItemContract> => {
  const { userAuthz, workItemRepo, usernameReader, timeProvider, dbExecutor } =
    deps;
  const parsedInput = editWorkItemInputSchema.parse(input);
  const workItemId = parseWorkItemId(parsedInput.workItemId);

  const run = async (tx: DbExecutor): Promise<WorkItemEntity> => {
    const txDeps = { ...deps, dbExecutor: tx };
    const workItem = await workItemRepo.load(workItemId, tx);
    if (!workItem) {
      throw new ResourceNotFoundError("Work item", workItemId);
    }

    await userAuthz.requireProjectPermission({
      projectId: workItem.projectId,
      permission: "work-items:write",
      dbExecutor: tx,
    });

    const editsContent =
      parsedInput.title !== undefined || parsedInput.description !== undefined;
    const now = timeProvider.now();
    let edited = workItem;

    if (editsContent) {
      requireNativeAuthor(workItem, userAuthz.actorId);
      edited = edited.edit(
        parsedInput.title ?? workItem.title,
        parsedInput.description ?? workItem.description,
        now,
      );
    }

    if (parsedInput.assigneeUserId !== undefined) {
      const assigneeUserId =
        parsedInput.assigneeUserId === null
          ? null
          : parseUuidV7(parsedInput.assigneeUserId);
      if (assigneeUserId !== null) {
        await requireProjectMember(workItem, assigneeUserId, txDeps);
      }
      edited = edited.assign(assigneeUserId, now);
    }
    const saved = await workItemRepo.save(edited, tx);

    if (
      parsedInput.description === undefined ||
      parsedInput.descriptionVersion === undefined
    ) {
      return saved;
    }
    return await workItemRepo.saveDescription(
      edited,
      parsedInput.descriptionVersion,
      tx,
    );
  };

  const persisted = dbExecutor
    ? await run(dbExecutor)
    : await getDb().transaction(async (tx) => await run(tx));

  const creatorsByUserId = await usernameReader.loadUsernamesByUserId(
    persisted.createdByUserId === null ? [] : [persisted.createdByUserId],
    dbExecutor,
  );
  const creator = persisted.createdByUserId
    ? creatorsByUserId.get(persisted.createdByUserId)
    : undefined;

  return workItemEntityToContract(
    persisted,
    creator?.username ?? null,
    creator?.image ?? null,
  );
};
