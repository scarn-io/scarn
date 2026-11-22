import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { oneLine } from "@scarn/core/tasks/task/application/task-summary-mapper";
import { workItemEntityToContract } from "./work-item-contract-mapper";
import type { WorkItemRepo } from "./work-item-repo";
import type {
  ChildWorkItemLatestTaskRecord,
  ChildWorkItemReader,
} from "./child-work-item-reader";
import {
  listWorkItemChildrenInputSchema,
  type ListWorkItemChildrenInput,
} from "../contracts/work-item-contracts";
import type {
  ChildWorkItemContract,
  ChildWorkItemLatestTaskContract,
} from "../contracts/child-work-item-contracts";
import { childWorkItemStatus } from "../domain/child-work-item-status";
import { parseWorkItemId } from "../domain/work-item-id";

type ListWorkItemChildrenDeps = {
  userAuthz: UserAuthorizationService;
  workItemRepo: WorkItemRepo;
  childWorkItemReader: ChildWorkItemReader;
  usernameReader: UsernameReader;
  dbExecutor?: DbExecutor;
};

const latestTaskToContract = (
  task: ChildWorkItemLatestTaskRecord,
): ChildWorkItemLatestTaskContract => ({
  id: task.id,
  status: task.status,
  step: task.step,
  startedAt: task.startedAt?.toISOString() ?? null,
  updatedAt: task.updatedAt.toISOString(),
  question:
    task.status === "waiting_for_person" && task.lastAgentMessage
      ? oneLine(task.lastAgentMessage)
      : null,
  failure:
    task.status === "failed" && task.errorMessage
      ? oneLine(task.errorMessage)
      : null,
});

/**
 * A work item's direct children, oldest first, each with its status
 * (`childWorkItemStatus`), assignee, open blockers and newest Task. Every
 * relation is read once for all the children.
 */
export const listWorkItemChildren = async (
  input: ListWorkItemChildrenInput,
  {
    userAuthz,
    workItemRepo,
    childWorkItemReader,
    usernameReader,
    dbExecutor,
  }: ListWorkItemChildrenDeps,
): Promise<ChildWorkItemContract[]> => {
  const workItemId = parseWorkItemId(
    listWorkItemChildrenInputSchema.parse(input),
  );

  const workItem = await workItemRepo.load(workItemId, dbExecutor);
  if (!workItem) {
    throw new ResourceNotFoundError("Work item", workItemId);
  }

  await userAuthz.requireProjectPermission({
    projectId: workItem.projectId,
    permission: "work-items:read",
    dbExecutor,
  });

  const children = await workItemRepo.listChildren(workItemId, dbExecutor);
  const childIds = children.map((child) => child.id);
  const [latestTasks, openBlockers, usersById] = await Promise.all([
    childWorkItemReader.loadLatestTasks(childIds, dbExecutor),
    childWorkItemReader.loadOpenBlockers(childIds, dbExecutor),
    usernameReader.loadUsernamesByUserId(
      children.flatMap((child) =>
        [child.createdByUserId, child.assigneeUserId].filter(
          (id): id is UuidV7 => id !== null,
        ),
      ),
      dbExecutor,
    ),
  ]);

  return children.map((child) => {
    const creator = child.createdByUserId
      ? usersById.get(child.createdByUserId)
      : undefined;
    const assignee = child.assigneeUserId
      ? usersById.get(child.assigneeUserId)
      : undefined;
    const latestTask = latestTasks.get(child.id) ?? null;
    const blockers = openBlockers.get(child.id) ?? [];
    return {
      ...workItemEntityToContract(
        child,
        creator?.username ?? null,
        creator?.image ?? null,
      ),
      status: childWorkItemStatus({
        state: child.state,
        hasOpenBlockers: blockers.length > 0,
        latestTaskStatus: latestTask?.status ?? null,
      }),
      assignee: child.assigneeUserId
        ? {
            userId: child.assigneeUserId,
            username: assignee?.username ?? null,
            image: assignee?.image ?? null,
          }
        : null,
      openBlockers: blockers,
      latestTask: latestTask ? latestTaskToContract(latestTask) : null,
    };
  });
};
