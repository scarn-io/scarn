import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import {
  CoreValidationError,
  InvariantViolationError,
  ResourceNotFoundError,
} from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { createSpawnedWorkItems } from "@scarn/core/tasks/task/application/create-spawned-work-items";
import type { TaskRepo } from "@scarn/core/tasks/task/application/task-repo";
import { WORK_ITEM_CHANGES_INVALID } from "@scarn/core/tasks/task/application/validate-work-item-changes";
import {
  findGrant,
  grantLabelsRefusal,
} from "@scarn/core/tasks/task/domain/grants";
import type { TaskEntity } from "@scarn/core/tasks/task/domain/task-entity";
import { DeferredWorkItemEvents } from "@scarn/core/work-items/work-item/application/deferred-work-item-events";
import type { WorkItemEventsPort } from "@scarn/core/work-items/work-item/application/work-item-events-port";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import type { WorkItemBlockRepo } from "@scarn/core/work-items/work-item-block/application/work-item-block-repo";
import {
  getTaskRunInputSchema,
  type GetTaskRunInput,
} from "../contracts/task-run-contracts";
import {
  createTaskRunWorkItemInputSchema,
  MAX_OPEN_CHILD_WORK_ITEMS,
  MAX_WORK_ITEMS_CREATED_PER_TASK,
  type CreatedTaskRunWorkItemContract,
  type CreateTaskRunWorkItemInput,
} from "../contracts/task-run-work-item-contracts";
import { assertClaimOwnership } from "./task-run-claim-helpers";
import type { TaskRunRepo } from "./task-run-repo";

export type CreateTaskRunWorkItemDeps = {
  taskRunRepo: Pick<TaskRunRepo, "load">;
  taskRepo: Pick<TaskRepo, "load" | "lockSpawnedWorkItems">;
  workItemRepo: WorkItemRepo;
  workItemBlockRepo: WorkItemBlockRepo;
  workItemEvents: WorkItemEventsPort;
  timeProvider: TimeProvider;
  /** Builds the actor for the user who claimed the run. */
  createUserAuthorizationService: (actorId: UuidV7) => UserAuthorizationService;
  dbExecutor?: DbExecutor | undefined;
};

const invalid = (message: string): CoreValidationError =>
  new CoreValidationError(message, WORK_ITEM_CHANGES_INVALID);

const checkCaps = async (
  task: TaskEntity,
  deps: CreateTaskRunWorkItemDeps,
  tx: DbExecutor,
): Promise<void> => {
  if (task.workItemId === null) {
    throw invalid("This Task has no work item to create children under");
  }
  await deps.taskRepo.lockSpawnedWorkItems(task.id, tx);
  const spawned = await deps.workItemRepo.countSpawnedByTask(task.id, tx);
  if (spawned >= MAX_WORK_ITEMS_CREATED_PER_TASK) {
    throw invalid(
      `This Task has already created ${String(spawned)} work items, the most one Task may create (${String(MAX_WORK_ITEMS_CREATED_PER_TASK)})`,
    );
  }
  const openChildren = (
    await deps.workItemRepo.listChildren(parseWorkItemId(task.workItemId), tx)
  ).filter((child) => child.state === "open").length;
  if (openChildren >= MAX_OPEN_CHILD_WORK_ITEMS) {
    throw invalid(
      `Work item ${task.workItemId} already has ${String(openChildren)} open children, the most a work item may have (${String(MAX_OPEN_CHILD_WORK_ITEMS)})`,
    );
  }
};

const checkBlockers = async (
  task: TaskEntity,
  blockedBy: readonly string[],
  deps: CreateTaskRunWorkItemDeps,
  tx: DbExecutor,
): Promise<void> => {
  if (blockedBy.length === 0) {
    return;
  }
  const found = new Map(
    (await deps.workItemRepo.loadMany(blockedBy.map(parseWorkItemId), tx)).map(
      (item) => [item.id as string, item],
    ),
  );
  for (const id of blockedBy) {
    const blocker = found.get(id);
    if (!blocker || blocker.projectId !== task.projectId) {
      throw invalid(
        `Blocker ${id} doesn't exist in this project; create it before the items it blocks`,
      );
    }
    if (
      id !== (task.workItemId as string) &&
      (blocker.parentWorkItemId as string | null) !== task.workItemId
    ) {
      throw invalid(
        `Work item ${id} can't block a new item: it is neither the Task's work item nor one of its children`,
      );
    }
  }
};

/**
 * Creates a child of a running Task's work item for its agent, in one
 * transaction, and commits it whatever the run does afterwards. Needs a
 * `create` grant on `children` that covers every label; `blockedBy` names
 * existing items, the Task's own or its children, and the blocks land before
 * readiness is checked. Per Task, creates take turns under an advisory lock
 * so the per-Task and open-children caps hold under parallel calls.
 *
 * The id is the one the agent's tool made: an id already naming this Task's
 * child returns it with `created: false`, so a retried request is safe.
 *
 * The run's claim token is the only credential; the item is created as the
 * user who claimed the run.
 */
export const createTaskRunWorkItem = async (
  taskRunIdInput: GetTaskRunInput,
  input: CreateTaskRunWorkItemInput,
  deps: CreateTaskRunWorkItemDeps,
): Promise<Result<CreatedTaskRunWorkItemContract, ResourceNotFoundError>> => {
  const taskRunId = getTaskRunInputSchema.parse(taskRunIdInput);
  const parsed = createTaskRunWorkItemInputSchema.parse(input);
  const db = deps.dbExecutor ?? getDb();

  return await db.transaction(async (tx) => {
    const run = await deps.taskRunRepo.load(taskRunId, tx);
    if (!run) {
      return Result.err(new ResourceNotFoundError("Task", taskRunId));
    }
    assertClaimOwnership(run, parsed.claimToken, deps.timeProvider.now());
    if (!run.claimedByUserId) {
      throw new InvariantViolationError(
        `Task run ${run.id} is running with no claiming user`,
        "TASK_RUN_CLAIMED_BY_USER_MISSING",
      );
    }

    const task = await deps.taskRepo.load(run.taskId, tx);
    const parent =
      task?.workItemId != null
        ? await deps.workItemRepo.load(parseWorkItemId(task.workItemId), tx)
      : null;
    if (!task || !parent || parent.projectId !== run.projectId) {
      return Result.err(new ResourceNotFoundError("Task", run.taskId));
    }

    const grant = findGrant(task.grants, "create", "children");
    if (!grant) {
      throw invalid(
        "This Task may not create work items: it has no create grant on children",
      );
    }
    const labelsRefusal = grantLabelsRefusal(
      grant,
      parsed.labels ?? [],
      parsed.workItemId,
    );
    if (labelsRefusal) {
      throw invalid(labelsRefusal);
    }

    const existing = await deps.workItemRepo.load(
      parseWorkItemId(parsed.workItemId),
      tx,
    );
    if (existing) {
      if (
        existing.spawnedByTaskId === task.id &&
        (existing.parentWorkItemId as string | null) === task.workItemId
      ) {
        return Result.ok({ workItemId: existing.id, created: false });
      }
      throw invalid(
        `Work item id ${parsed.workItemId} is already used; make a new id`,
      );
    }

    await checkCaps(task, deps, tx);
    await checkBlockers(task, parsed.blockedBy ?? [], deps, tx);

    const workItemEvents = new DeferredWorkItemEvents(deps.workItemEvents);
    await createSpawnedWorkItems(
      task,
      [parsed],
      {
        ...deps,
        userAuthz: deps.createUserAuthorizationService(run.claimedByUserId),
        workItemEvents,
      },
      tx,
    );
    await workItemEvents.flush(tx);
    return Result.ok({ workItemId: parsed.workItemId, created: true });
  });
};
