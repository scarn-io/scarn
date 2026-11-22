import {
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import type {
  CreateWorkItemBlockProps,
  WorkItemBlockEntity,
} from "../domain/work-item-block-entity";
import {
  workItemBlockSchema,
  type CreateWorkItemBlockParsed,
  type WorkItemBlockContract,
} from "../contracts/work-item-block-contracts";

export const createWorkItemBlockInputToProps = (
  input: CreateWorkItemBlockParsed,
  context: { projectId: UuidV7; createdByUserId: UuidV7 },
): CreateWorkItemBlockProps => ({
  projectId: context.projectId,
  blockedWorkItemId: parseUuidV7(input.blockedWorkItemId),
  blockingWorkItemId: parseUuidV7(input.blockingWorkItemId),
  createdByUserId: context.createdByUserId,
});

export const workItemBlockEntityToContract = (
  block: WorkItemBlockEntity,
): WorkItemBlockContract =>
  workItemBlockSchema.parse({
    id: block.id,
    projectId: block.projectId,
    blockedWorkItemId: block.blockedWorkItemId,
    blockingWorkItemId: block.blockingWorkItemId,
    createdByUserId: block.createdByUserId,
    createdAt: block.createdAt?.toISOString() ?? null,
  });
