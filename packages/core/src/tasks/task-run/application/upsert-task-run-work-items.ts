import { getDb } from "@scarn/core/lib/db";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import {
  createGrantFor,
  updateGrantFor,
  type Grant,
} from "@scarn/core/tasks/task/domain/grants";
import type { TaskEntity } from "@scarn/core/tasks/task/domain/task-entity";
import { DeferredWorkItemEvents } from "@scarn/core/work-items/work-item/application/deferred-work-item-events";
import {
  upsertWorkItems,
  type UpsertWorkItemsDeps,
} from "@scarn/core/work-items/work-item/application/upsert-work-item";
import { parseWorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import {
  getTaskRunInputSchema,
  type GetTaskRunInput,
} from "../contracts/task-run-contracts";
import {
  upsertTaskRunWorkItemsInputSchema,
  type UpsertedTaskRunWorkItemsContract,
  type UpsertTaskRunWorkItemsInput,
} from "../contracts/task-run-work-item-contracts";
import {
  grantMissing,
  requireCodeStepWorkItemAccess,
  type CodeStepWorkItemAccessDeps,
} from "./code-step-work-item-access";

export type UpsertTaskRunWorkItemsDeps = CodeStepWorkItemAccessDeps &
  Omit<UpsertWorkItemsDeps, "userAuthz" | "dbExecutor"> & {
    dbExecutor?: DbExecutor | undefined;
  };

type ParsedItem = ReturnType<
  typeof upsertTaskRunWorkItemsInputSchema.parse
>["items"][number];

const identityKey = (item: { platform: string; platformKey: string }) =>
  `${item.platform}:${item.platformKey}`;

/**
 * Why `grants` don't cover writing `item`, or null when they do: a new key
 * needs a `create` grant on `project` covering it, an existing one an
 * `update` grant, and either must cover every label the item sets. An
 * `update` grant naming no labels covers any.
 */
const grantRefusal = (
  grants: readonly Grant[],
  item: ParsedItem,
  exists: boolean,
): string | null => {
  const action = exists ? "update" : "create";
  const grant = exists
    ? updateGrantFor(grants, item.platformKey)
    : createGrantFor(grants, item.platformKey);
  const what = `${exists ? "existing" : "new"} ${item.platform} item ${item.platformKey}`;
  if (!grant) {
    return `This step may not write the ${what}: it has no ${action} grant on project covering that key`;
  }
  const allowed = grant.labels;
  if (allowed === undefined) {
    return null;
  }
  const outside = (item.labels ?? []).filter(
    (label) => !allowed.includes(label),
  );
  return outside.length === 0
    ? null
    : `This step may not write the ${what} with labels ${outside.join(", ")}: its ${action} grant on project covers ${allowed.join(", ")}`;
};

const requireGrants = (
  task: TaskEntity,
  items: readonly ParsedItem[],
  existingKeys: ReadonlySet<string>,
): void => {
  const refusals = items.flatMap((item) => {
    const refusal = grantRefusal(
      task.grants,
      item,
      existingKeys.has(identityKey(item)),
    );
    return refusal ? [refusal] : [];
  });
  if (refusals.length > 0) {
    throw grantMissing(
      `Nothing was written. ${refusals.slice(0, 10).join("; ")}${refusals.length > 10 ? `; and ${String(refusals.length - 10)} more` : ""}`,
      { refused: refusals.length },
    );
  }
};

/**
 * Writes a code step's imported items into its run's project, in one
 * transaction, as the user who claimed the run, through the same
 * `upsertWorkItems` a user's sync uses. Each item is checked first: a key the
 * project lacks needs a `create` grant on `project`, one it has an `update`
 * grant, each covering the key's prefix and the item's labels. One miss fails
 * the whole call with `WORK_ITEM_GRANT_MISSING` and writes nothing.
 *
 * An item only overwrites a stored one when its `sourceUpdatedAt` is strictly
 * newer; older ones are left out of the result and counted as `unchanged`.
 * A source close or reopen closes or reopens the stored item. New items are
 * stamped as spawned by the run's Task; there is no per-Task cap.
 */
export const upsertTaskRunWorkItems = async (
  taskRunIdInput: GetTaskRunInput,
  input: UpsertTaskRunWorkItemsInput,
  deps: UpsertTaskRunWorkItemsDeps,
): Promise<Result<UpsertedTaskRunWorkItemsContract, ResourceNotFoundError>> => {
  const taskRunId = getTaskRunInputSchema.parse(taskRunIdInput);
  const parsed = upsertTaskRunWorkItemsInputSchema.parse(input);
  const db = deps.dbExecutor ?? getDb();

  return await db.transaction(async (tx) => {
    const access = await requireCodeStepWorkItemAccess(
      taskRunId,
      parsed.claimToken,
      "work-items:write",
      deps,
      tx,
    );
    if (!access.ok) {
      return Result.err(access.error);
    }
    const { run, task, userAuthz } = access.value;

    const existing = await deps.workItemRepo.loadManyByPlatformIdentities(
      parsed.items.map((item) => ({
        projectId: run.projectId,
        platform: item.platform,
        sourceIdentity: item.platformKey,
      })),
      tx,
    );
    const existingKeys = new Set(existing.map(identityKey));
    requireGrants(task, parsed.items, existingKeys);

    const workItemEvents = new DeferredWorkItemEvents(deps.workItemEvents);
    const written = await upsertWorkItems(
      parsed.items.map((item) => ({
        ...item,
        projectId: run.projectId,
        sourceCreatedAt: item.sourceCreatedAt ?? null,
        fields: item.fields ?? null,
      })),
      { ...deps, userAuthz, workItemEvents, dbExecutor: tx },
      { onlyIfSourceNewer: true, spawnedByTaskId: task.id },
    );
    await workItemEvents.flush(tx);

    const items = written.map((item) => ({
      workItemId: parseWorkItemId(item.id),
      platform: item.platform,
      platformKey: item.platformKey,
      outcome: existingKeys.has(identityKey(item))
        ? ("updated" as const)
        : ("created" as const),
    }));
    const created = items.filter((item) => item.outcome === "created").length;
    return Result.ok({
      items,
      counts: {
        created,
        updated: items.length - created,
        unchanged: parsed.items.length - items.length,
      },
    });
  });
};
