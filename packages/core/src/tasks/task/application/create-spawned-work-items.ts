import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreValidationError } from "@scarn/core/lib/errors";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import { createWorkItems } from "@scarn/core/work-items/work-item/application/create-work-item";
import type { WorkItemEventsPort } from "@scarn/core/work-items/work-item/application/work-item-events-port";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import {
  parseWorkItemId,
  type WorkItemId,
} from "@scarn/core/work-items/work-item/domain/work-item-id";
import type { WorkItemPlatform } from "@scarn/core/work-items/work-item/domain/work-item-platform";
import { createWorkItemBlock } from "@scarn/core/work-items/work-item-block/application/create-work-item-block";
import type { WorkItemBlockRepo } from "@scarn/core/work-items/work-item-block/application/work-item-block-repo";
import type { TaskEntity } from "../domain/task-entity";

/** A child work item an agent Task creates, named by the id its tool made. */
export type SpawnedWorkItemCreate = {
  workItemId: string;
  title: string;
  description: string;
  fields?: Record<string, unknown> | undefined;
  labels?: string[] | undefined;
  blockedBy?: string[] | undefined;
};

export type CreateSpawnedWorkItemsDeps = {
  userAuthz: UserAuthorizationService;
  workItemRepo: WorkItemRepo;
  workItemBlockRepo: WorkItemBlockRepo;
  workItemEvents: WorkItemEventsPort;
  timeProvider: TimeProvider;
};

/**
 * Creates an agent Task's children under its work item, through the work
 * item front doors in `tx`: native `scarn` items keyed `manual-<id>`, stamped
 * with the spawning Task, then each one's `blockedBy` blocks. Checks nothing
 * about the Task's grants; callers validate first.
 *
 * Pass a `DeferredWorkItemEvents` as `workItemEvents` and flush it after, so
 * readiness is checked once the blocks exist.
 */
export const createSpawnedWorkItems = async (
  task: TaskEntity,
  creates: readonly SpawnedWorkItemCreate[],
  deps: CreateSpawnedWorkItemsDeps,
  tx: DbExecutor,
): Promise<void> => {
  if (creates.length === 0) {
    return;
  }
  const parentWorkItemId = task.workItemId;
  if (parentWorkItemId === null) {
    throw new CoreValidationError(
      "This Task has no work item to create children under",
      "WORK_ITEM_CHANGES_INVALID",
    );
  }
  const created = await createWorkItems(
    creates.map((create) => ({
      projectId: task.projectId,
      platform: "scarn",
      platformKey: `manual-${create.workItemId}`,
      title: create.title,
      description: create.description,
      sourceCreatedAt: null,
      sourceUpdatedAt: null,
      fields: create.fields ?? {},
      labels: create.labels,
    })),
    { ...deps, dbExecutor: tx },
    creates.map((create) => ({
      id: parseWorkItemId(create.workItemId),
      parentWorkItemId: parseWorkItemId(parentWorkItemId),
      spawnedByTaskId: task.id,
    })),
  );
  if (!created.ok) {
    throw created.error;
  }
  for (const create of creates) {
    for (const blocker of create.blockedBy ?? []) {
      await createWorkItemBlock(
        { blockedWorkItemId: create.workItemId, blockingWorkItemId: blocker },
        { ...deps, dbExecutor: tx },
      );
    }
  }
};

/** A top-level work item an agent Task creates in its project. */
export type ProjectWorkItemCreate = {
  workItemId: string;
  platform: WorkItemPlatform;
  platformKey: string;
  url?: string | undefined;
  title: string;
  description: string;
  fields?: Record<string, unknown> | undefined;
  labels?: string[] | undefined;
};

/**
 * Creates a top-level item in an agent Task's project, stamped with the
 * spawning Task, unless the project already has its `(platform,
 * platformKey)`: then it returns that item untouched, so `workItem.created`
 * fires once per key. A concurrent create of the same key resolves the same
 * way. Checks nothing about the Task's grants; callers validate first.
 */
export const createProjectWorkItem = async (
  task: TaskEntity,
  create: ProjectWorkItemCreate,
  deps: CreateSpawnedWorkItemsDeps,
  tx: DbExecutor,
): Promise<{ workItemId: WorkItemId; created: boolean }> => {
  const findExisting = async () =>
    (
      await deps.workItemRepo.loadManyByPlatformIdentities(
        [
          {
            projectId: task.projectId,
            platform: create.platform,
            sourceIdentity: create.platformKey,
          },
        ],
        tx,
      )
    )[0];
  const existing = await findExisting();
  if (existing) {
    return { workItemId: existing.id, created: false };
  }
  const created = await createWorkItems(
    [
      {
        projectId: task.projectId,
        platform: create.platform,
        platformKey: create.platformKey,
        url: create.url ?? null,
        title: create.title,
        description: create.description,
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        fields: create.fields ?? {},
        labels: create.labels,
      },
    ],
    { ...deps, dbExecutor: tx },
    [
      {
        id: parseWorkItemId(create.workItemId),
        parentWorkItemId: null,
        spawnedByTaskId: task.id,
      },
    ],
  );
  if (created.ok) {
    return { workItemId: parseWorkItemId(create.workItemId), created: true };
  }
  const raced = await findExisting();
  if (!raced) {
    throw created.error;
  }
  return { workItemId: raced.id, created: false };
};
