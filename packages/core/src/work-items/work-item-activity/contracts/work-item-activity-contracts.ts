import { z } from "zod";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { workItemIdSchema } from "@scarn/core/work-items/work-item/contracts/work-item-contracts";
import { WORK_ITEM_ACTIVITY_KINDS } from "../domain/work-item-activity-entry";

export const workItemActivityEntrySchema = z.object({
  id: uuidV7Schema,
  workItemId: uuidV7Schema,
  kind: z.enum(WORK_ITEM_ACTIVITY_KINDS),
  message: z.string(),
  createdAt: z.iso.datetime(),
});

export const listWorkItemActivityInputSchema = workItemIdSchema;

export type WorkItemActivityEntryContract = z.infer<
  typeof workItemActivityEntrySchema
>;
export type ListWorkItemActivityInput = z.input<
  typeof listWorkItemActivityInputSchema
>;
