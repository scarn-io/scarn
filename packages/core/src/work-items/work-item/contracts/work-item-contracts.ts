import { z } from "zod";
import { isWorkItemId, type WorkItemId } from "../domain/work-item-id";
import { WORK_ITEM_STATES } from "../domain/work-item-state";
import { WORK_ITEM_CLOSE_REASONS } from "../domain/work-item-close-reason";
import { WORK_ITEM_PLATFORMS } from "../domain/work-item-platform";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { anyJsonObjectSchema } from "@scarn/core/common/contracts/json";
import { pipelineRunStatusValues } from "@scarn/core/pipeline-executions/pipeline-run/domain/pipeline-run-entity";

export const workItemIdSchema = z.string().trim().refine(isWorkItemId, {
  message: "Work item id must be a UUID v7",
}) as z.ZodType<WorkItemId>;

export const workItemPlatformSchema = z.enum(WORK_ITEM_PLATFORMS);

export const workItemStateSchema = z.enum(WORK_ITEM_STATES);

export const workItemCloseReasonSchema = z.enum(WORK_ITEM_CLOSE_REASONS);

export const workItemSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  platform: workItemPlatformSchema,
  platformId: z.string().trim().min(1).nullable().optional(),
  platformKey: z.string().trim().min(1),
  url: z.url().nullable().optional(),
  title: z.string().trim().min(1),
  description: z.string().min(1),
  // Moves on every description write; a person's edit names the one it loaded.
  descriptionVersion: z.number().int().positive(),
  sourceCreatedAt: z.iso.datetime({ offset: true }).nullable(),
  sourceUpdatedAt: z.iso.datetime({ offset: true }).nullable(),
  fields: anyJsonObjectSchema.nullable(),
  // Label names, case kept. Synced items carry the tracker's labels, replaced
  // on every sync; only native items take label writes from Scarn.
  labels: z.array(z.string()),
  // Identity of record for the work item's creator (`null` for legacy/
  // externally-synced items with no known creator). Unlike
  // `createdByUsername`/`createdByImage` below, this is never re-resolved at
  // read time — it's the persisted `work_items.created_by_user_id` column.
  createdByUserId: uuidV7Schema.nullable(),
  // Read-time-resolved creator display fields (never supplied on input). The
  // creator identity of record is `work_items.created_by_user_id`; these are
  // resolved through the UsernameReader at read time.
  createdByUsername: z.string().nullable(),
  createdByImage: z.string().nullable(),
  // The project member responsible for the item; `null` when unassigned.
  // Set through `PATCH /work-items/:id`, never through creation or sync.
  assigneeUserId: uuidV7Schema.nullable(),
  // Self-referential parent link for the child/parent work-item hierarchy.
  // Not settable through creation/upsert/ingestion input in v1 (see
  // `createWorkItemSchema`'s `.omit`) — parenting is a separate,
  // dedicated mutation (`setWorkItemParentInputSchema`) applied after a work
  // item already exists.
  parentWorkItemId: workItemIdSchema.nullable(),
  state: workItemStateSchema,
  // Set while the item is closed, all `null` while it's open. A sync close
  // is `completed` with no resolution and no closer.
  closeReason: workItemCloseReasonSchema.nullable(),
  resolution: z.string().nullable(),
  closedAt: z.iso.datetime().nullable(),
  closedByUserId: uuidV7Schema.nullable(),
  closedByTaskId: uuidV7Schema.nullable(),
  spawnedByTaskId: uuidV7Schema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const createWorkItemSchema = workItemSchema
  .omit({
    id: true,
    descriptionVersion: true,
    createdByUserId: true,
    createdByUsername: true,
    createdByImage: true,
    assigneeUserId: true,
    parentWorkItemId: true,
    state: true,
    closeReason: true,
    resolution: true,
    closedAt: true,
    closedByUserId: true,
    closedByTaskId: true,
    spawnedByTaskId: true,
    createdAt: true,
    updatedAt: true,
    labels: true,
  })
  .extend({
    state: workItemStateSchema.optional(),
    // Replaces the whole list when given. An upsert that leaves it out keeps
    // an existing item's labels.
    labels: z.array(z.string()).optional(),
  });

export const workItemIngestionInputSchema = createWorkItemSchema.omit({
  projectId: true,
});

export const upsertWorkItemInputSchema = createWorkItemSchema;

/**
 * `POST /work-items`. A native item's creator may make its id, as agent
 * creates do, so its `platformKey` can be `manual-<id>`.
 */
export const createWorkItemInputSchema = createWorkItemSchema.extend({
  id: workItemIdSchema.optional(),
});

export const upsertWorkItemsInputSchema = z
  .array(upsertWorkItemInputSchema)
  .min(1);
export const getWorkItemInputSchema = workItemIdSchema;
export const listWorkItemChildrenInputSchema = workItemIdSchema;
export const deleteWorkItemInputSchema = workItemIdSchema;
export const deleteWorkItemsInputSchema = z
  .array(deleteWorkItemInputSchema)
  .min(1);

const editWorkItemFieldsSchema = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().trim().min(1).optional(),
  // The `descriptionVersion` the editor loaded; required with `description`.
  // The write is refused (409) when the description has moved since.
  descriptionVersion: z.number().int().positive().optional(),
  // Omitted leaves the assignee as is; `null` clears it.
  assigneeUserId: uuidV7Schema.nullable().optional(),
});

type EditWorkItemFields = z.infer<typeof editWorkItemFieldsSchema>;

const hasAnyEditField = (fields: EditWorkItemFields) =>
  fields.title !== undefined ||
  fields.description !== undefined ||
  fields.assigneeUserId !== undefined;

const EMPTY_EDIT_MESSAGE = {
  message: "Provide at least one of title, description, or assigneeUserId",
};

const namesDescriptionVersion = (fields: EditWorkItemFields) =>
  fields.description === undefined || fields.descriptionVersion !== undefined;

const DESCRIPTION_VERSION_MESSAGE = {
  message: "Provide descriptionVersion with description",
  path: ["descriptionVersion"],
};

/**
 * A partial edit. Title and description edits are limited to the author of a
 * native item; an assignee-only edit is open to any project member who may
 * update work items, on native and synced items alike.
 */
export const editWorkItemBodySchema = editWorkItemFieldsSchema
  .refine(hasAnyEditField, EMPTY_EDIT_MESSAGE)
  .refine(namesDescriptionVersion, DESCRIPTION_VERSION_MESSAGE);

export const editWorkItemInputSchema = editWorkItemFieldsSchema
  .extend({ workItemId: workItemIdSchema })
  .refine(hasAnyEditField, EMPTY_EDIT_MESSAGE)
  .refine(namesDescriptionVersion, DESCRIPTION_VERSION_MESSAGE);

const workItemLabelListSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(50);

/** Labels to add, then labels to remove. At least one label overall. */
export const labelWorkItemBodySchema = z
  .object({
    add: workItemLabelListSchema.optional(),
    remove: workItemLabelListSchema.optional(),
  })
  .refine((body) => (body.add?.length ?? 0) + (body.remove?.length ?? 0) > 0, {
    message: "Provide at least one label in add or remove",
  });

export const labelWorkItemInputSchema = z.object({
  workItemId: workItemIdSchema,
  add: workItemLabelListSchema.optional(),
  remove: workItemLabelListSchema.optional(),
});

export const setWorkItemParentInputSchema = z.object({
  workItemId: workItemIdSchema,
  parentWorkItemId: workItemIdSchema.nullable(),
});

/**
 * Body of a close or reopen. `reason` defaults to `completed`; `resolution`
 * is only meaningful on a close and is posted as a comment when non-empty.
 */
export const setWorkItemStateBodySchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("closed"),
    reason: workItemCloseReasonSchema.default("completed"),
    resolution: z.string().trim().max(10_000).nullable().optional(),
  }),
  z.object({
    state: z.literal("open"),
  }),
]);

export const setWorkItemStateInputSchema = z.intersection(
  z.object({ workItemId: workItemIdSchema }),
  setWorkItemStateBodySchema,
);

export const workItemProjectionSpecSchema = z.object({
  id: z.string().trim().min(1),
  fields: z.array(z.string().trim().min(1)).min(1),
});

/** Max distinct values returned per field key by the field-options query. */
export const MAX_FIELD_OPTION_VALUES = 200;
/** Max distinct field keys returned by the field-options query. */
export const MAX_FIELD_OPTION_KEYS = 100;

/** Default page size for work item listing. */
export const DEFAULT_WORK_ITEMS_PAGE_SIZE = 25;
/** Hard upper bound on the requested page size. */
export const MAX_WORK_ITEMS_PAGE_SIZE = 100;

/**
 * A work item as returned by the paginated listing endpoint. `signalScore` and
 * `latestExecutionStatus` are both query metadata, not part of the aggregate:
 * `signalScore` is the latest score for the sorted-on signal (`null` when
 * unsorted or when the item has no numeric score), and `latestExecutionStatus`
 * is the derived status of the work item's most recently created pipeline
 * execution (`null` when it has never had one).
 *
 * `latestExecutionStatus` is a plain string rather than
 * `z.enum(pipelineRunStatusValues)` to avoid a new cross-module
 * contract dependency from `work-items` onto `pipeline-executions` for a
 * single display-only field — see `packages/core/src/pipeline-executions/
 * pipeline-run/domain/pipeline-run-entity.ts` for the
 * source of truth on the actual value set.
 */
/** The assignee of a listed work item, with read-time display fields. */
export const workItemAssigneeSchema = z.object({
  userId: uuidV7Schema,
  username: z.string().nullable(),
  image: z.string().nullable(),
});

/**
 * How many of a work item's Tasks sit in each live or attention-needing
 * status, for the list's Agent column. `running` counts Tasks a worker has
 * claimed and `queued` those still waiting for one; `waitingOnYou` is the
 * subset of `waitingForPerson` whose conversation waits on the viewer.
 * Finished Tasks are not counted.
 */
export const workItemTaskStatusCountsSchema = z.object({
  running: z.number().int().nonnegative(),
  queued: z.number().int().nonnegative(),
  waitingForPerson: z.number().int().nonnegative(),
  waitingOnYou: z.number().int().nonnegative(),
  waitingForWork: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const workItemListItemSchema = workItemSchema.extend({
  signalScore: z.number().nullable(),
  latestExecutionStatus: z.string().nullable(),
  // Count of pending/failed `work_item_platform_comment` drafts on this item.
  // Always `0` (never omitted or `null`) — for a caller lacking
  // `work-item-platform-comment:create` it is a literal `0` rather than a
  // computed-then-masked real value; see `listWorkItemsByProject`'s
  // `includeAwaitingApprovalData` derivation.
  awaitingApprovalCount: z.number().int(),
  assignee: workItemAssigneeSchema.nullable(),
  taskStatusCounts: workItemTaskStatusCountsSchema,
});

/**
 * The list's Agent filter: items with at least one Task that waits on the
 * viewer, is running, is queued, waits on blockers, or failed. Named after the
 * Tasks tab's status presets (`TASK_STATUS_PRESETS`).
 */
export const WORK_ITEM_AGENT_FILTERS = [
  "waiting_on_me",
  "running",
  "queued",
  "waiting_on_blockers",
  "failed",
] as const;

export const workItemAgentFilterSchema = z.enum(WORK_ITEM_AGENT_FILTERS);

/** `me` is the viewer, `none` is unassigned, otherwise a user id. */
export const workItemAssigneeFilterSchema = z.union([
  z.literal("me"),
  z.literal("none"),
  uuidV7Schema,
]);

/** Stored status of a work item's latest pipeline run. */
export const workItemLatestExecutionStatusFilterSchema = z.enum(
  pipelineRunStatusValues,
);

export const workItemFieldFilterSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});

/**
 * Prefix for the dynamic `fields` filter params on the work-item listing
 * endpoint: `f.<encodeURIComponent(key)>=<value>`.
 *
 * The key segment is URI-encoded so keys containing `%`, `&`, `=`, `.`, or
 * spaces (e.g. Jira custom fields) round-trip unambiguously, and the route
 * decodes the segment after the prefix with `decodeURIComponent`. Because the
 * params are dynamic they cannot be declared in a schema, so this constant is
 * the whole of the shared grammar — it lives here so the browser that writes
 * these params and the route that reads them cannot drift apart.
 */
export const WORK_ITEM_FIELD_FILTER_PREFIX = "f.";

const RELATIVE_TIME_BOUND_PATTERN = /^\d{1,5}[hd]$/;
const ABSOLUTE_TIME_BOUND_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date the pattern accepts but the calendar does not (`2026-02-31`) is junk.
 * `Date` silently rolls it forward to March 3rd rather than refusing it, so the
 * round-trip is what actually catches it.
 */
const isRealCalendarDate = (value: string): boolean => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().startsWith(`${value}T`)
  );
};

/**
 * One end of an `updated` window, in either of two forms:
 *
 * - relative — `24h`, `7d`: that far back from the request's clock.
 * - absolute — `2026-01-14`: the start of that day, UTC.
 *
 * Relative bounds are deliberately not resolved by the caller. A URL meaning
 * "the last 7 days" has to still mean that next week, so the window is measured
 * server-side against the `TimeProvider`'s clock at query time.
 */
export const timeBoundSchema = z
  .string()
  .trim()
  .refine(
    (value) =>
      RELATIVE_TIME_BOUND_PATTERN.test(value) ||
      (ABSOLUTE_TIME_BOUND_PATTERN.test(value) && isRealCalendarDate(value)),
    { message: "Time bound must be `<N>h`, `<N>d`, or `YYYY-MM-DD`" },
  );

/**
 * The `sort` axis for the work item listing: `created`/`updated` need only a
 * direction, while `score` also carries the pipeline, step key and dotted
 * result path (`signalKey`) of the number to sort by — read from the Task
 * result of each run's latest non-superseded visit to that step. See
 * `parseWorkItemSortToken` for the URL token grammar (`created-desc`,
 * `updated-asc`, `score:<pipelineId>:<stepKey>:<resultPath>:<asc|desc>`) that
 * produces this shape.
 */
export const workItemSortSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("created"), direction: z.enum(["asc", "desc"]) }),
  z.object({ kind: z.literal("updated"), direction: z.enum(["asc", "desc"]) }),
  z.object({
    kind: z.literal("score"),
    pipelineDefinitionId: uuidV7Schema,
    stepKey: z.string().trim().min(1),
    signalKey: z.string().trim().min(1),
    direction: z.enum(["asc", "desc"]),
  }),
]);

export const listWorkItemsQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  fieldFilters: z.array(workItemFieldFilterSchema).default([]),
  // Items carrying every one of these labels (case-sensitive).
  labels: z.array(z.string().trim().min(1)).default([]),
  // Bounds on the item's effective last-updated instant —
  // `coalesce(sourceUpdatedAt, updatedAt)`, the same expression the default
  // ordering uses. Half-open: `updatedAfter` is inclusive, `updatedBefore` is
  // exclusive, so the two compose into a range without overlapping.
  updatedAfter: timeBoundSchema.optional(),
  updatedBefore: timeBoundSchema.optional(),
  // Server-side gated behind the caller's `work-item-platform-comment:create`
  // permission — see `listWorkItemsByProject`'s `includeAwaitingApprovalData`
  // derivation. Absent this permission the param is silently dropped rather
  // than rejected, matching this schema's tolerance for the other filter
  // params.
  awaitingApproval: z.coerce.boolean().optional(),
  assignee: workItemAssigneeFilterSchema.optional(),
  agent: workItemAgentFilterSchema.optional(),
  latestExecutionStatus: workItemLatestExecutionStatusFilterSchema.optional(),
  platform: workItemPlatformSchema.optional(),
  sort: workItemSortSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_WORK_ITEMS_PAGE_SIZE)
    .default(DEFAULT_WORK_ITEMS_PAGE_SIZE),
});

export const paginatedWorkItemsSchema = z.object({
  items: z.array(workItemListItemSchema),
  pagination: z.object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  }),
});

export const workItemFieldOptionSchema = z.object({
  key: z.string(),
  values: z.array(z.string()),
  truncated: z.boolean(),
});

export type WorkItemContract = z.infer<typeof workItemSchema>;
export type CreateWorkItemInput = z.input<typeof createWorkItemSchema>;
export type WorkItemIngestionInput = z.input<
  typeof workItemIngestionInputSchema
>;
export type UpsertWorkItemInput = z.input<typeof upsertWorkItemInputSchema>;
export type CreateWorkItemRequestInput = z.input<
  typeof createWorkItemInputSchema
>;
export type UpsertWorkItemsInput = z.input<typeof upsertWorkItemsInputSchema>;
export type GetWorkItemInput = z.input<typeof getWorkItemInputSchema>;
export type ListWorkItemChildrenInput = z.input<
  typeof listWorkItemChildrenInputSchema
>;
export type DeleteWorkItemInput = z.input<typeof deleteWorkItemInputSchema>;
export type DeleteWorkItemsInput = z.input<typeof deleteWorkItemsInputSchema>;
export type EditWorkItemInput = z.input<typeof editWorkItemInputSchema>;
export type LabelWorkItemInput = z.input<typeof labelWorkItemInputSchema>;
export type SetWorkItemParentInput = z.input<
  typeof setWorkItemParentInputSchema
>;
export type SetWorkItemStateInput = z.input<typeof setWorkItemStateInputSchema>;
export type WorkItemCloseReasonContract = z.infer<
  typeof workItemCloseReasonSchema
>;
export type WorkItemProjectionSpecContract = z.infer<
  typeof workItemProjectionSpecSchema
>;
export type WorkItemListItemContract = z.infer<typeof workItemListItemSchema>;
export type WorkItemAssigneeContract = z.infer<typeof workItemAssigneeSchema>;
export type WorkItemTaskStatusCounts = z.infer<
  typeof workItemTaskStatusCountsSchema
>;
export type WorkItemAgentFilter = z.infer<typeof workItemAgentFilterSchema>;
export type WorkItemFieldFilter = z.infer<typeof workItemFieldFilterSchema>;
export type WorkItemTimeBound = z.infer<typeof timeBoundSchema>;
export type WorkItemSort = z.infer<typeof workItemSortSchema>;
export type WorkItemSignalSort = Extract<WorkItemSort, { kind: "score" }>;
export type ListWorkItemsQuery = z.infer<typeof listWorkItemsQuerySchema>;
export type ListWorkItemsQueryInput = z.input<typeof listWorkItemsQuerySchema>;
export type PaginatedWorkItemsContract = z.infer<
  typeof paginatedWorkItemsSchema
>;
export type WorkItemFieldOptionContract = z.infer<
  typeof workItemFieldOptionSchema
>;
