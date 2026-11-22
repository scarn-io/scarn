import { z } from "zod";
import {
  isWorkItemBlockId,
  type WorkItemBlockId,
} from "../domain/work-item-block-id";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { workItemIdSchema } from "@scarn/core/work-items/work-item/contracts/work-item-contracts";

export const workItemBlockIdSchema = z
  .string()
  .trim()
  .refine(isWorkItemBlockId, {
    message: "Work item block id must be a UUID v7",
  }) as z.ZodType<WorkItemBlockId>;

export const workItemBlockSchema = z.object({
  id: uuidV7Schema,
  projectId: uuidV7Schema,
  blockedWorkItemId: uuidV7Schema,
  blockingWorkItemId: uuidV7Schema,
  createdByUserId: uuidV7Schema.nullable(),
  createdAt: z.iso.datetime(),
});

export const createWorkItemBlockInputSchema = z.object({
  blockedWorkItemId: workItemIdSchema,
  blockingWorkItemId: workItemIdSchema,
});

export const deleteWorkItemBlockInputSchema = workItemBlockIdSchema;

export const listWorkItemBlocksInputSchema = workItemIdSchema;

export type WorkItemBlockContract = z.infer<typeof workItemBlockSchema>;
export type CreateWorkItemBlockInput = z.input<
  typeof createWorkItemBlockInputSchema
>;
export type CreateWorkItemBlockParsed = z.infer<
  typeof createWorkItemBlockInputSchema
>;
export type DeleteWorkItemBlockInput = z.input<
  typeof deleteWorkItemBlockInputSchema
>;
export type ListWorkItemBlocksInput = z.input<
  typeof listWorkItemBlocksInputSchema
>;

export type ListWorkItemBlocksResult = {
  blockedBy: WorkItemBlockContract[];
  blocking: WorkItemBlockContract[];
};
