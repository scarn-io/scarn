import { z } from "zod";
import { anyJsonObjectSchema } from "@scarn/core/common/contracts/json";
import { labelsSchema } from "@scarn/core/tasks/task/domain/grants";
import { taskStatusValues } from "@scarn/core/tasks/task/domain/task-entity";
import { workItemCommentIdSchema } from "@scarn/core/work-items/work-item-comment/contracts/work-item-comment-contracts";
import {
  workItemCloseReasonSchema,
  workItemIdSchema,
  workItemPlatformSchema,
  workItemStateSchema,
} from "@scarn/core/work-items/work-item/contracts/work-item-contracts";

/** At most this many items spawned by one Task, across all its runs. */
export const MAX_WORK_ITEMS_CREATED_PER_TASK = 10;
/**
 * The same cap for a Task creating top-level items in its project, such as a
 * scheduled poller: higher, since one run may find many new items.
 */
export const MAX_PROJECT_WORK_ITEMS_CREATED_PER_TASK = 100;
/** The platform of every item a Task creates in its project. */
export const PROJECT_WORK_ITEM_PLATFORM = "custom";
/** At most this many open children under one parent. */
export const MAX_OPEN_CHILD_WORK_ITEMS = 50;
/** Fixed page size for posted comments in an agent's work-item read. */
export const TASK_RUN_WORK_ITEM_COMMENTS_PAGE_SIZE = 50;

/** Omit `commentsCursor` for the first page; otherwise pass `comments.nextCursor` unchanged. */
export const readTaskRunWorkItemInputSchema = z.object({
  claimToken: z.string().trim().min(1),
  workItemId: workItemIdSchema,
  commentsCursor: z.string().min(1).optional(),
});

/**
 * A work item a running Task's agent creates. `workItemId` is the UUIDv7 the
 * agent's tool made, so a retry names the same item.
 *
 * - `scope: "children"` (the default): a child of the Task's work item.
 * - `scope: "project"`: a top-level item in the Task's project, keyed by
 *   `platformKey`, a stable id from the system the item comes from. A key the
 *   project already has returns that item unchanged. Takes no `blockedBy`.
 */
export const createTaskRunWorkItemInputSchema = z
  .object({
    claimToken: z.string().trim().min(1),
    workItemId: workItemIdSchema,
    scope: z.enum(["children", "project"]).default("children"),
    platformKey: z.string().trim().min(1).max(500).optional(),
    url: z.url().optional(),
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().min(1).max(50_000),
    fields: anyJsonObjectSchema.optional(),
    labels: labelsSchema.optional(),
    blockedBy: z.array(workItemIdSchema).max(50).optional(),
  })
  .superRefine((value, context) => {
    if (value.scope === "project") {
      if (value.platformKey === undefined) {
        context.addIssue({
          code: "custom",
          message:
            "A project create needs a platformKey: a stable id from the system the item comes from",
          path: ["platformKey"],
        });
      }
      if (value.blockedBy !== undefined && value.blockedBy.length > 0) {
        context.addIssue({
          code: "custom",
          message: "A project create takes no blockedBy",
          path: ["blockedBy"],
        });
      }
      return;
    }
    for (const key of ["platformKey", "url"] as const) {
      if (value[key] !== undefined) {
        context.addIssue({
          code: "custom",
          message: `Only a project create takes ${key}`,
          path: [key],
        });
      }
    }
  });

/**
 * `created` is false when the id already named this Task's child (a replay),
 * or, for a project create, when the project already had its `platformKey`.
 */
export const createdTaskRunWorkItemSchema = z.object({
  workItemId: workItemIdSchema,
  created: z.boolean(),
});

/**
 * A blocker or child of the item read. `blockedBy` holds its open blockers'
 * ids only; `latestTaskStatus` is its newest Task's status, null when it has
 * never had a Task.
 */
const relatedWorkItemSchema = z.object({
  id: workItemIdSchema,
  title: z.string(),
  state: workItemStateSchema,
  labels: z.array(z.string()),
  closeReason: workItemCloseReasonSchema.nullable(),
  resolution: z.string().nullable(),
  blockedBy: z.array(workItemIdSchema),
  latestTaskStatus: z.enum(taskStatusValues).nullable(),
});

/** Posted comment content only, with a resolved author display name and no dashboard metadata. */
export const agentWorkItemCommentSchema = z.object({
  id: workItemCommentIdSchema,
  parentCommentId: workItemCommentIdSchema.nullable(),
  body: z.string(),
  authorKind: z.enum(["user", "agent"]),
  authorName: z.string().trim().min(1),
  isPinned: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/**
 * Posted comments ordered by isPinned DESC, createdAt DESC, then id DESC.
 * Each page contains at most 50 comments, including when pinned comments span
 * multiple pages. `totalCount` counts all posted comments on this work item;
 * `nextCursor` is opaque and null only when there are no further results.
 * Bodies are complete, never truncated, and parentCommentId is preserved even
 * when the parent is outside this page. Pagination is a live view, not a
 * historical snapshot: pinning, edits and deletions can change between requests.
 */
export const agentWorkItemCommentsPageSchema = z.object({
  items: z
    .array(agentWorkItemCommentSchema)
    .max(TASK_RUN_WORK_ITEM_COMMENTS_PAGE_SIZE),
  totalCount: z.number().int().nonnegative(),
  nextCursor: z.string().min(1).nullable(),
});

/**
 * A work item as an agent's `scarn-get-work-item` tool sees it, read live.
 * `descriptionVersion` is what a description write must name.
 */
export const taskRunWorkItemSchema = z.object({
  id: workItemIdSchema,
  title: z.string(),
  labels: z.array(z.string()),
  description: z.string().nullable(),
  descriptionVersion: z.number().int().positive(),
  fields: anyJsonObjectSchema,
  platform: workItemPlatformSchema,
  platformKey: z.string(),
  parentWorkItemId: workItemIdSchema.nullable(),
  state: workItemStateSchema,
  closeReason: workItemCloseReasonSchema.nullable(),
  resolution: z.string().nullable(),
  /** Items that block this one. */
  blockers: z.array(relatedWorkItemSchema),
  children: z.array(relatedWorkItemSchema),
  comments: agentWorkItemCommentsPageSchema,
});

export type AgentWorkItemComment = z.infer<typeof agentWorkItemCommentSchema>;
export type AgentWorkItemCommentsPage = z.infer<
  typeof agentWorkItemCommentsPageSchema
>;

export type ReadTaskRunWorkItemInput = z.input<
  typeof readTaskRunWorkItemInputSchema
>;
export type CreateTaskRunWorkItemInput = z.input<
  typeof createTaskRunWorkItemInputSchema
>;
export type CreatedTaskRunWorkItemContract = z.infer<
  typeof createdTaskRunWorkItemSchema
>;
export type TaskRunWorkItemContract = z.infer<typeof taskRunWorkItemSchema>;
export type RelatedWorkItemContract = z.infer<typeof relatedWorkItemSchema>;
