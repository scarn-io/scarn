import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { CoreValidationError } from "@scarn/core/lib/errors";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import type { WorkItemEntity } from "@scarn/core/work-items/work-item/domain/work-item-entity";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import type { WorkItemChange } from "../contracts/work-item-change-contracts";
import {
  findGrant,
  grantLabelsRefusal,
  type Grant,
  type GrantAction,
  type ChangeGrantScope,
} from "../domain/grants";
import type { TaskEntity } from "../domain/task-entity";

export const WORK_ITEM_CHANGES_INVALID = "WORK_ITEM_CHANGES_INVALID";
export const WORK_ITEM_CHANGE_NOT_NATIVE = "WORK_ITEM_NOT_NATIVE";

const invalid = (message: string): CoreValidationError =>
  new CoreValidationError(message, WORK_ITEM_CHANGES_INVALID);

const notNative = (workItemId: string): CoreValidationError =>
  new CoreValidationError(
    `Work item ${workItemId} is synced from another tracker; agents can only change native items`,
    WORK_ITEM_CHANGE_NOT_NATIVE,
  );

/** Every item a change names. */
const referencedIds = (changes: WorkItemChange[]): string[] =>
  changes.flatMap((change) =>
    change.kind === "block"
      ? [change.blockedWorkItemId, change.blockingWorkItemId]
      : [change.workItemId],
  );

type Scope = {
  task: TaskEntity;
  existing: Map<string, WorkItemEntity>;
};

/**
 * Which scope covers an item: `self` for the Task's own, `children` for one
 * of its children, `null` for anything else.
 */
const scopeOf = (scope: Scope, workItemId: string): ChangeGrantScope | null => {
  if (scope.task.workItemId === null) {
    return null;
  }
  if (workItemId === scope.task.workItemId) {
    return "self";
  }
  if (
    scope.existing.get(workItemId)?.parentWorkItemId ===
    (scope.task.workItemId as string)
  ) {
    return "children";
  }
  return null;
};

const requireGrant = <A extends GrantAction>(
  scope: Scope,
  action: A,
  workItemId: string,
): Extract<Grant, { action: A }> => {
  const itemScope = scopeOf(scope, workItemId);
  if (!itemScope) {
    throw invalid(
      `This Task may not ${action} work item ${workItemId}: it is neither the Task's work item nor one of its children`,
    );
  }
  const grant = findGrant(scope.task.grants, action, itemScope);
  if (!grant) {
    throw invalid(
      `This Task may not ${action} work item ${workItemId}: it has no ${action} grant on ${itemScope}`,
    );
  }
  return grant;
};

const requireLabels = (
  grant: Extract<Grant, { labels: string[] }>,
  labels: readonly string[],
  workItemId: string,
): void => {
  const refusal = grantLabelsRefusal(grant, labels, workItemId);
  if (refusal) {
    throw invalid(refusal);
  }
};

/**
 * A block needs a `block` grant on the blocked item's scope, and the blocking
 * item must be in that grant's scope too.
 */
const requireBlock = (
  scope: Scope,
  blockedWorkItemId: string,
  blockingWorkItemId: string,
): void => {
  const grant = requireGrant(scope, "block", blockedWorkItemId);
  if (scopeOf(scope, blockingWorkItemId) !== grant.scope) {
    throw invalid(
      `This Task may not block work item ${blockedWorkItemId} on ${blockingWorkItemId}: its block grant on ${grant.scope} doesn't cover ${blockingWorkItemId}`,
    );
  }
};

const requireNative = (scope: Scope, workItemId: string): void => {
  const existing = scope.existing.get(workItemId);
  if (existing && existing.platform !== "scarn") {
    throw notNative(workItemId);
  }
};

/** Checks one change against the Task's scope and what came before it. */
const checkChange = (
  scope: Scope,
  change: WorkItemChange,
  state: {
    versions: Map<string, number>;
    descriptions: Map<string, string | null>;
    closed: Set<string>;
  },
): void => {
  switch (change.kind) {
    case "block":
      requireBlock(scope, change.blockedWorkItemId, change.blockingWorkItemId);
      requireNative(scope, change.blockedWorkItemId);
      if (change.blockedWorkItemId === change.blockingWorkItemId) {
        throw invalid("A work item can't block itself");
      }
      return;
    case "describe": {
      requireGrant(scope, "update", change.workItemId);
      requireNative(scope, change.workItemId);
      const version =
        state.versions.get(change.workItemId) ??
        scope.existing.get(change.workItemId)?.descriptionVersion ??
        1;
      if (change.descriptionVersion !== version) {
        throw invalid(
          `Work item ${change.workItemId} description is at version ${String(version)}, not ${String(change.descriptionVersion)}; read it again`,
        );
      }
      const current = state.descriptions.has(change.workItemId)
        ? state.descriptions.get(change.workItemId)
        : scope.existing.get(change.workItemId)?.description;
      if (change.description !== current) {
        state.versions.set(change.workItemId, version + 1);
      }
      state.descriptions.set(change.workItemId, change.description);
      return;
    }
    case "comment":
      requireGrant(scope, "comment", change.workItemId);
      requireNative(scope, change.workItemId);
      return;
    case "label": {
      const grant = requireGrant(scope, "label", change.workItemId);
      requireNative(scope, change.workItemId);
      if (!change.add?.length && !change.remove?.length) {
        throw invalid(
          `A label change on work item ${change.workItemId} must add or remove a label`,
        );
      }
      requireLabels(
        grant,
        [...(change.add ?? []), ...(change.remove ?? [])],
        change.workItemId,
      );
      return;
    }
    case "close":
      requireGrant(scope, "close", change.workItemId);
      requireNative(scope, change.workItemId);
      if (
        state.closed.has(change.workItemId) ||
        scope.existing.get(change.workItemId)?.state === "closed"
      ) {
        throw invalid(`Work item ${change.workItemId} is already closed`);
      }
      state.closed.add(change.workItemId);
      return;
  }
};

/**
 * Checks an agent's work item changes against its Task before any is applied:
 * the Task has a grant for each change's action on the scope of every item it
 * names (and the labels it sets), every changed item is native, and
 * description writes name the version they read. Throws a
 * `CoreValidationError` coded `WORK_ITEM_NOT_NATIVE` or
 * `WORK_ITEM_CHANGES_INVALID` on the first change that fails.
 */
export const validateWorkItemChanges = async (
  task: TaskEntity,
  changes: WorkItemChange[],
  deps: { workItemRepo: Pick<WorkItemRepo, "loadMany"> },
  tx: DbExecutor,
): Promise<void> => {
  const existingIds: string[] = [
    ...new Set([
      ...(task.workItemId === null ? [] : [task.workItemId]),
      ...referencedIds(changes),
    ]),
  ];
  const existing = new Map(
    (
      await deps.workItemRepo.loadMany(existingIds.map(parseWorkItemId), tx)
    ).map((workItem) => [workItem.id as string, workItem]),
  );
  const unknown = existingIds.find(
    (id) => existing.get(id)?.projectId !== task.projectId,
  );
  if (unknown) {
    throw invalid(`Work item ${unknown} doesn't exist in this project`);
  }

  const scope: Scope = { task, existing };
  const state = {
    versions: new Map<string, number>(),
    descriptions: new Map<string, string | null>(),
    closed: new Set<string>(),
  };
  for (const change of changes) {
    checkChange(scope, change, state);
  }
};
