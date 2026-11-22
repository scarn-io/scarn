import { z } from "zod";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { taskStatusValues } from "@scarn/core/tasks/task/domain/task-entity";
import { CHILD_WORK_ITEM_STATUSES } from "../domain/child-work-item-status";
import {
  workItemAssigneeSchema,
  workItemIdSchema,
  workItemSchema,
} from "./work-item-contracts";

/** A child work item's newest Task, as its row in the children section shows it. */
export const childWorkItemLatestTaskSchema = z.object({
  id: uuidV7Schema,
  status: z.enum(taskStatusValues),
  /** The step the Task was started from; `null` for a prompt or code Task. */
  step: z.object({ key: z.string(), name: z.string() }).nullable(),
  /** When its first run started; `null` before any run. */
  startedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
  /** Its agent's hand-over message, on one line, while it waits for a person. */
  question: z.string().nullable(),
  /** Its error message, on one line, once it has failed. */
  failure: z.string().nullable(),
});

/**
 * A child work item with where it stands (`childWorkItemStatus`): its
 * assignee, its open blockers' titles and its newest Task.
 */
export const childWorkItemSchema = workItemSchema.extend({
  status: z.enum(CHILD_WORK_ITEM_STATUSES),
  assignee: workItemAssigneeSchema.nullable(),
  openBlockers: z.array(z.object({ id: workItemIdSchema, title: z.string() })),
  latestTask: childWorkItemLatestTaskSchema.nullable(),
});

/** The most ids one `work-item-statuses` lookup resolves. */
export const MAX_WORK_ITEM_STATUS_IDS = 100;

/**
 * A work item's live title and status (`childWorkItemStatus`), for showing a
 * link to it, such as one in a description.
 */
export const workItemStatusSummarySchema = z.object({
  id: uuidV7Schema,
  title: z.string(),
  status: z.enum(CHILD_WORK_ITEM_STATUSES),
});

export type WorkItemStatusSummaryContract = z.infer<
  typeof workItemStatusSummarySchema
>;
export type ChildWorkItemLatestTaskContract = z.infer<
  typeof childWorkItemLatestTaskSchema
>;
export type ChildWorkItemContract = z.infer<typeof childWorkItemSchema>;
