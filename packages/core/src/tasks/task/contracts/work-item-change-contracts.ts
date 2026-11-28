import { z } from "zod";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { labelsSchema } from "@scarn/core/tasks/task/domain/grants";
import { WORK_ITEM_CLOSE_REASONS } from "@scarn/core/work-items/work-item/domain/work-item-close-reason";

const textSchema = z.string().trim().min(1).max(50_000);

/**
 * One change an agent's work item tool recorded during a run, in
 * `.scarn/work-item-changes.json`. The worker sends the list with the run's
 * completion and the server applies it in the completion transaction. Items
 * are named by id; agents create work items directly during the run, so a
 * change may name an item created earlier in it.
 */
export const workItemChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("label"),
    workItemId: uuidV7Schema,
    add: labelsSchema.optional(),
    remove: labelsSchema.optional(),
  }),
  z.object({
    kind: z.literal("block"),
    blockedWorkItemId: uuidV7Schema,
    blockingWorkItemId: uuidV7Schema,
    remove: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("describe"),
    workItemId: uuidV7Schema,
    description: textSchema,
    descriptionVersion: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("comment"),
    workItemId: uuidV7Schema,
    body: textSchema,
  }),
  z.object({
    kind: z.literal("close"),
    workItemId: uuidV7Schema,
    reason: z.enum(WORK_ITEM_CLOSE_REASONS),
    resolution: z.string().trim().max(10_000).nullable().optional(),
  }),
]);

/** The most work item changes a Task applies when it succeeds, held ones included. */
export const MAX_WORK_ITEM_CHANGES = 200;

export const workItemChangesSchema = z
  .array(workItemChangeSchema)
  .max(MAX_WORK_ITEM_CHANGES);

export type WorkItemChange = z.infer<typeof workItemChangeSchema>;
export type WorkItemChangeKind = WorkItemChange["kind"];
