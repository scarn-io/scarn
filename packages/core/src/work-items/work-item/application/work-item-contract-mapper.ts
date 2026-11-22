import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type {
  CreateWorkItemProps,
  WorkItemEntity,
} from "../domain/work-item-entity";
import {
  workItemSchema,
  type WorkItemContract,
  type UpsertWorkItemInput,
} from "../contracts/work-item-contracts";

export const upsertWorkItemInputToCreateWorkItemProps = (
  input: UpsertWorkItemInput,
): CreateWorkItemProps => ({
  projectId: parseUuidV7(input.projectId),
  platform: input.platform,
  platformId: input.platformId,
  platformKey: input.platformKey,
  url: input.url,
  title: input.title,
  description: input.description,
  sourceCreatedAt: input.sourceCreatedAt,
  sourceUpdatedAt: input.sourceUpdatedAt,
  fields: (input.fields ?? {}) as CreateWorkItemProps["fields"],
  labels: input.labels,
  state: input.state,
});

export const workItemEntityToContract = (
  workItem: WorkItemEntity,
  createdByUsername: string | null = null,
  createdByImage: string | null = null,
): WorkItemContract =>
  workItemSchema.parse({
    id: workItem.id,
    projectId: workItem.projectId,
    platform: workItem.platform,
    platformId: workItem.platformId,
    platformKey: workItem.platformKey,
    url: workItem.url,
    title: workItem.title,
    description: workItem.description ?? "(No description provided.)",
    descriptionVersion: workItem.descriptionVersion,
    sourceCreatedAt: workItem.sourceCreatedAt?.toISOString() ?? null,
    sourceUpdatedAt: workItem.sourceUpdatedAt?.toISOString() ?? null,
    fields: workItem.fields,
    labels: [...workItem.labels],
    createdByUserId: workItem.createdByUserId,
    createdByUsername,
    createdByImage,
    assigneeUserId: workItem.assigneeUserId,
    parentWorkItemId: workItem.parentWorkItemId,
    state: workItem.state,
    closeReason: workItem.closure?.reason ?? null,
    resolution: workItem.closure?.resolution ?? null,
    closedAt: workItem.closure?.closedAt.toISOString() ?? null,
    closedByUserId: workItem.closure?.closedByUserId ?? null,
    closedByTaskId: workItem.closure?.closedByTaskId ?? null,
    spawnedByTaskId: workItem.spawnedByTaskId,
    createdAt: workItem.createdAt?.toISOString() ?? null,
    updatedAt: workItem.updatedAt?.toISOString() ?? null,
  });
