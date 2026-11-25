import { sql } from "drizzle-orm";
import { workItems } from "@scarn/core/lib/db/schema";
import type { WorkItemEntity } from "../domain/work-item-entity";

const descriptionChanged = `excluded.${workItems.description.name} is distinct from work_items.${workItems.description.name}`;

const syncedDescriptionSet = {
  description: sql.raw(`excluded.${workItems.description.name}`),
  descriptionVersion: sql.raw(
    `case when ${descriptionChanged} then work_items.${workItems.descriptionVersion.name} + 1 else work_items.${workItems.descriptionVersion.name} end`,
  ),
};

/**
 * `setWhere` for `saveManyIfSourceNewer` (decisions 6/12): update a
 * conflicting row only when the incoming one is strictly newer at the source,
 * or nothing was stored yet. A stale row is left untouched and dropped from
 * `RETURNING`.
 */
export const sourceNewerGuard = sql.raw(
  `excluded.${workItems.sourceUpdatedAt.name} > work_items.${workItems.sourceUpdatedAt.name} or work_items.${workItems.sourceUpdatedAt.name} is null`,
);

/**
 * Shared `ON CONFLICT ... DO UPDATE SET` clause for the upsert (conflict on
 * `projectId`/`platform`/`platformKey`). `"sync"` is the ingestion-style
 * upsert behind `saveMany` (unconditional) and `saveManyIfSourceNewer`
 * (guarded by `setWhere`): the tracker owns a synced item's description, so
 * it overwrites it and bumps the version whenever the text changes. `"scarn"`
 * is `save`, the Scarn-side write: it changes the assignee and never touches
 * an existing row's description, which only `saveDescription` writes.
 */
export const workItemUpsertSet = (writer: "sync" | "scarn") => ({
  // A source that doesn't know the item's platform id (GitHub's MCP
  // `list_issues` has no node id) keeps the one another source stored.
  platformId: sql.raw(
    `coalesce(excluded.${workItems.platformId.name}, work_items.${workItems.platformId.name})`,
  ),
  url: sql.raw(`excluded.${workItems.url.name}`),
  title: sql.raw(`excluded.${workItems.title.name}`),
  ...(writer === "sync" ? syncedDescriptionSet : {}),
  sourceCreatedAt: sql.raw(`excluded.${workItems.sourceCreatedAt.name}`),
  sourceUpdatedAt: sql.raw(`excluded.${workItems.sourceUpdatedAt.name}`),
  fields: sql.raw(`excluded.${workItems.fields.name}`),
  labels: sql.raw(`excluded.${workItems.labels.name}`),
  // Preserve the original creator on conflict (do NOT overwrite from
  // excluded), the same way createdAt is preserved below.
  createdByUserId: sql.raw(`work_items.${workItems.createdByUserId.name}`),
  assigneeUserId: sql.raw(
    `${writer === "scarn" ? "excluded" : "work_items"}.${workItems.assigneeUserId.name}`,
  ),
  createdAt: sql.raw(`work_items.${workItems.createdAt.name}`),
  // Always take the incoming entity's parentWorkItemId, whether that's a
  // fresh value from `setWorkItemParent` (via `save`) or a value already
  // preserved from the current row by the caller (upsert's ingestion path
  // carries the existing parent forward before ever reaching here) — see
  // `upsert-work-item.ts`.
  parentWorkItemId: sql.raw(`excluded.${workItems.parentWorkItemId.name}`),
  // `state` and the closure columns are deliberately absent: an existing row
  // keeps them, and only `setStateMany` (via `setWorkItemState`) changes them.
  spawnedByTaskId: sql.raw(`work_items.${workItems.spawnedByTaskId.name}`),
  updatedAt: sql.raw(`excluded.${workItems.updatedAt.name}`),
});

export const toClosureColumns = (workItem: WorkItemEntity) => ({
  closeReason: workItem.closure?.reason ?? null,
  resolution: workItem.closure?.resolution ?? null,
  closedAt: workItem.closure?.closedAt ?? null,
  closedByUserId: workItem.closure?.closedByUserId ?? null,
  closedByTaskId: workItem.closure?.closedByTaskId ?? null,
});

export const toWorkItemRow = (workItem: WorkItemEntity) => ({
  id: workItem.id,
  projectId: workItem.projectId,
  platform: workItem.platform,
  platformId: workItem.platformId,
  platformKey: workItem.platformKey,
  url: workItem.url,
  title: workItem.title,
  description: workItem.description,
  descriptionVersion: workItem.descriptionVersion,
  sourceCreatedAt: workItem.sourceCreatedAt,
  sourceUpdatedAt: workItem.sourceUpdatedAt,
  fields: workItem.fields,
  labels: [...workItem.labels],
  createdByUserId: workItem.createdByUserId,
  assigneeUserId: workItem.assigneeUserId,
  parentWorkItemId: workItem.parentWorkItemId,
  state: workItem.state,
  ...toClosureColumns(workItem),
  spawnedByTaskId: workItem.spawnedByTaskId,
  createdAt: workItem.createdAt ?? new Date(),
  updatedAt: workItem.updatedAt ?? new Date(),
});
