import {
  CoreValidationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UsernameReader } from "@scarn/core/organizations/organization/application/username-reader";
import type { TaskRepo } from "@scarn/core/tasks/task/application/task-repo";
import type { WorkItemBlockRepo } from "@scarn/core/work-items/work-item-block/application/work-item-block-repo";
import type { CommentTaskNameReader } from "@scarn/core/work-items/work-item-comment/application/comment-task-name-reader";
import { workItemCommentPageToAgentContract } from "@scarn/core/work-items/work-item-comment/application/work-item-comment-page-mapper";
import type { WorkItemCommentRepo } from "@scarn/core/work-items/work-item-comment/application/work-item-comment-repo";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import type { WorkItemEntity } from "@scarn/core/work-items/work-item/domain/work-item-entity";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import {
  findGrant,
  type GrantScope,
} from "@scarn/core/tasks/task/domain/grants";
import { WORK_ITEM_CHANGES_INVALID } from "@scarn/core/tasks/task/application/validate-work-item-changes";
import {
  getTaskRunInputSchema,
  type GetTaskRunInput,
} from "../contracts/task-run-contracts";
import {
  readTaskRunWorkItemInputSchema,
  type ReadTaskRunWorkItemInput,
  type RelatedWorkItemContract,
  type TaskRunWorkItemContract,
} from "../contracts/task-run-work-item-contracts";
import { assertClaimOwnership } from "./task-run-claim-helpers";
import type { TaskRunRepo } from "./task-run-repo";

/**
 * A live read of one work item for a running Task's agent: its own item with
 * a `read` grant on `self`, a child of it with `read` on `children`, or any
 * item in its project with `read` on `project`. Its
 * blockers and children carry their labels, open blockers and newest Task's
 * status, each relation loaded in one query for all of them.
 *
 * The run's claim token is the only credential. The agent's tool calls this
 * from inside the runtime, which must not hold the worker's session, and a
 * claim token reaches no further than the items this one run may touch, and
 * only while the run holds its lease.
 */
export const readTaskRunWorkItem = async (
  taskRunIdInput: GetTaskRunInput,
  input: ReadTaskRunWorkItemInput,
  deps: {
    taskRunRepo: Pick<TaskRunRepo, "load">;
    taskRepo: Pick<TaskRepo, "load" | "loadLatestStatusByWorkItemIds">;
    workItemRepo: Pick<WorkItemRepo, "load" | "loadMany" | "listChildren">;
    workItemCommentRepo: Pick<WorkItemCommentRepo, "loadPageByWorkItemId">;
    usernameReader: UsernameReader;
    commentTaskNameReader: CommentTaskNameReader;
    workItemBlockRepo: Pick<
      WorkItemBlockRepo,
      "listByWorkItem" | "listOpenBlockerIdsByBlocked"
    >;
    timeProvider: TimeProvider;
  },
): Promise<Result<TaskRunWorkItemContract, ResourceNotFoundError>> => {
  const taskRunId = getTaskRunInputSchema.parse(taskRunIdInput);
  const parsed = readTaskRunWorkItemInputSchema.parse(input);
  const run = await deps.taskRunRepo.load(taskRunId);
  if (!run) {
    return Result.err(new ResourceNotFoundError("Task", taskRunId));
  }
  assertClaimOwnership(run, parsed.claimToken, deps.timeProvider.now());

  const task = await deps.taskRepo.load(run.taskId);
  const workItem = await deps.workItemRepo.load(
    parseWorkItemId(parsed.workItemId),
  );
  if (!task || !workItem || workItem.projectId !== run.projectId) {
    return Result.err(new ResourceNotFoundError("WorkItem", parsed.workItemId));
  }
  const scope: GrantScope =
    (workItem.id as string) === task.workItemId
      ? "self"
      : (workItem.parentWorkItemId as string | null) === task.workItemId
        ? "children"
        : "project";
  if (
    !findGrant(task.grants, "read", scope) &&
    !findGrant(task.grants, "read", "project")
  ) {
    throw new CoreValidationError(
      `This Task may not read work item ${workItem.id}: it has no read grant on ${scope}`,
      WORK_ITEM_CHANGES_INVALID,
    );
  }

  const [blocks, children, commentPage] = await Promise.all([
    deps.workItemBlockRepo.listByWorkItem(parseUuidV7(workItem.id)),
    deps.workItemRepo.listChildren(workItem.id),
    deps.workItemCommentRepo.loadPageByWorkItemId(
      parseUuidV7(workItem.id),
      parsed.commentsCursor,
    ),
  ]);
  const comments = await workItemCommentPageToAgentContract(commentPage, deps);
  const blockerIds = blocks
    .filter((block) => (block.blockedWorkItemId as string) === workItem.id)
    .map((block) => parseWorkItemId(block.blockingWorkItemId));
  const blockers =
    blockerIds.length > 0 ? await deps.workItemRepo.loadMany(blockerIds) : [];

  const relatedIds = [...blockers, ...children].map((item) =>
    parseUuidV7(item.id),
  );
  const [openBlockerIds, latestTaskStatuses] = await Promise.all([
    deps.workItemBlockRepo.listOpenBlockerIdsByBlocked(relatedIds),
    deps.taskRepo.loadLatestStatusByWorkItemIds(relatedIds),
  ]);
  const toRelated = (related: WorkItemEntity): RelatedWorkItemContract => {
    const id = parseUuidV7(related.id);
    return {
      id: related.id,
      title: related.title,
      state: related.state,
      labels: [...related.labels],
      closeReason: related.closure?.reason ?? null,
      resolution: related.closure?.resolution ?? null,
      blockedBy: (openBlockerIds.get(id) ?? []).map(parseWorkItemId),
      latestTaskStatus: latestTaskStatuses.get(id) ?? null,
    };
  };

  return Result.ok({
    id: workItem.id,
    title: workItem.title,
    labels: [...workItem.labels],
    description: workItem.description,
    descriptionVersion: workItem.descriptionVersion,
    fields: workItem.fields,
    platform: workItem.platform,
    platformKey: workItem.platformKey,
    parentWorkItemId: workItem.parentWorkItemId,
    state: workItem.state,
    closeReason: workItem.closure?.reason ?? null,
    resolution: workItem.closure?.resolution ?? null,
    blockers: blockers.map(toRelated),
    children: children.map(toRelated),
    comments,
  });
};
