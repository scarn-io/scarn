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
import {
  createProjectWorkItem,
  createSpawnedWorkItems,
} from "@scarn/core/tasks/task/application/create-spawned-work-items";
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
  MAX_PROJECT_WORK_ITEMS_CREATED_PER_TASK,
  MAX_WORK_ITEMS_CREATED_PER_TASK,
  PROJECT_WORK_ITEM_PLATFORM,
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

type ParsedCreate = ReturnType<typeof createTaskRunWorkItemInputSchema.parse>;

const invalid = (message: string): CoreValidationError =>
  new CoreValidationError(message, WORK_ITEM_CHANGES_INVALID);

const checkCreatedCap = async (
  task: TaskEntity,
  max: number,
  deps: CreateTaskRunWorkItemDeps,
  tx: DbExecutor,
): Promise<void> => {
  const spawned = await deps.workItemRepo.countSpawnedByTask(task.id, tx);
  if (spawned >= max) {
    throw invalid(
      `This Task has already created ${String(spawned)} work items, the most one Task may create (${String(max)})`,
    );
  }
};

const checkOpenChildrenCap = async (
  parentWorkItemId: string,
  deps: CreateTaskRunWorkItemDeps,
  tx: DbExecutor,
): Promise<void> => {
  const openChildren = (
    await deps.workItemRepo.listChildren(parseWorkItemId(parentWorkItemId), tx)
  ).filter((child) => child.state === "open").length;
  if (openChildren >= MAX_OPEN_CHILD_WORK_ITEMS) {
    throw invalid(
      `Work item ${parentWorkItemId} already has ${String(openChildren)} open children, the most a work item may have (${String(MAX_OPEN_CHILD_WORK_ITEMS)})`,
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

const requireCreateGrant = (task: TaskEntity, parsed: ParsedCreate): void => {
  const grant = findGrant(task.grants, "create", parsed.scope);
  if (!grant) {
    throw invalid(
      `This Task may not create work items: it has no create grant on ${parsed.scope}`,
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
};

const createChild = async (
  task: TaskEntity,
  parsed: ParsedCreate,
  userAuthz: UserAuthorizationService,
  deps: CreateTaskRunWorkItemDeps,
  tx: DbExecutor,
): Promise<CreatedTaskRunWorkItemContract> => {
  const parentWorkItemId = task.workItemId;
  if (parentWorkItemId === null) {
    throw invalid("This Task has no work item to create children under");
  }
  const existing = await deps.workItemRepo.load(
    parseWorkItemId(parsed.workItemId),
    tx,
  );
  if (existing) {
    if (
      existing.spawnedByTaskId === task.id &&
      (existing.parentWorkItemId as string | null) === parentWorkItemId
    ) {
      return { workItemId: existing.id, created: false };
    }
    throw invalid(
      `Work item id ${parsed.workItemId} is already used; make a new id`,
    );
  }

  await deps.taskRepo.lockSpawnedWorkItems(task.id, tx);
  await checkCreatedCap(task, MAX_WORK_ITEMS_CREATED_PER_TASK, deps, tx);
  await checkOpenChildrenCap(parentWorkItemId, deps, tx);
  await checkBlockers(task, parsed.blockedBy ?? [], deps, tx);

  const workItemEvents = new DeferredWorkItemEvents(deps.workItemEvents);
  await createSpawnedWorkItems(
    task,
    [parsed],
    { ...deps, userAuthz, workItemEvents },
    tx,
  );
  await workItemEvents.flush(tx);
  return { workItemId: parseWorkItemId(parsed.workItemId), created: true };
};

const createInProject = async (
  task: TaskEntity,
  parsed: ParsedCreate,
  userAuthz: UserAuthorizationService,
  deps: CreateTaskRunWorkItemDeps,
  tx: DbExecutor,
): Promise<CreatedTaskRunWorkItemContract> => {
  const platformKey = parsed.platformKey;
  if (platformKey === undefined) {
    throw invalid("A project create needs a platformKey");
  }
  await deps.taskRepo.lockSpawnedWorkItems(task.id, tx);
  const known = await deps.workItemRepo.loadManyByPlatformIdentities(
    [
      {
        projectId: task.projectId,
        platform: PROJECT_WORK_ITEM_PLATFORM,
        sourceIdentity: platformKey,
      },
    ],
    tx,
  );
  const knownItem = known[0];
  if (knownItem) {
    return { workItemId: knownItem.id, created: false };
  }
  if (await deps.workItemRepo.load(parseWorkItemId(parsed.workItemId), tx)) {
    throw invalid(
      `Work item id ${parsed.workItemId} is already used; make a new id`,
    );
  }
  await checkCreatedCap(
    task,
    MAX_PROJECT_WORK_ITEMS_CREATED_PER_TASK,
    deps,
    tx,
  );

  const workItemEvents = new DeferredWorkItemEvents(deps.workItemEvents);
  const result = await createProjectWorkItem(
    task,
    {
      workItemId: parsed.workItemId,
      platform: PROJECT_WORK_ITEM_PLATFORM,
      platformKey,
      url: parsed.url,
      title: parsed.title,
      description: parsed.description,
      fields: parsed.fields,
      labels: parsed.labels,
    },
    { ...deps, userAuthz, workItemEvents },
    tx,
  );
  await workItemEvents.flush(tx);
  return result;
};

/**
 * Creates a work item for a running Task's agent, in one transaction, and
 * commits it whatever the run does afterwards. Needs a `create` grant on the
 * requested scope that covers every label. Per Task, creates take turns under
 * an advisory lock so the caps hold under parallel calls.
 *
 * - `children`: a child of the Task's work item. `blockedBy` names existing
 *   items, the Task's own or its children, and the blocks land before
 *   readiness is checked. The id is the one the agent's tool made: an id
 *   already naming this Task's child returns it with `created: false`, so a
 *   retried request is safe.
 * - `project`: a top-level item in the Task's project, on platform `custom`
 *   keyed by `platformKey`. A key the project already has returns that item,
 *   untouched, with `created: false`, and `workItem.created` doesn't fire, so
 *   a poller may send every item it sees.
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
    if (!task || task.projectId !== run.projectId) {
      return Result.err(new ResourceNotFoundError("Task", run.taskId));
    }
    if (parsed.scope === "children" && task.workItemId !== null) {
      const parent = await deps.workItemRepo.load(
        parseWorkItemId(task.workItemId),
        tx,
      );
      if (!parent || parent.projectId !== run.projectId) {
        return Result.err(new ResourceNotFoundError("Task", run.taskId));
      }
    }

    requireCreateGrant(task, parsed);
    const userAuthz = deps.createUserAuthorizationService(run.claimedByUserId);
    return Result.ok(
      parsed.scope === "project"
        ? await createInProject(task, parsed, userAuthz, deps, tx)
        : await createChild(task, parsed, userAuthz, deps, tx),
    );
  });
};
