import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { WorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";
import type { WorkItemAutomationEntity } from "../domain/work-item-automation-entity";
import type { ResolvedAutomation } from "./automation-repo";

/** An attachment with the automation it attaches and that automation's latest version. */
export type ResolvedWorkItemAutomation = ResolvedAutomation & {
  attachment: WorkItemAutomationEntity;
};

export type WorkItemAutomationRepo = {
  load(
    workItemId: WorkItemId,
    automationId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemAutomationEntity | null>;
  /** The work item's attachments with their automations' latest versions, in key order. */
  listByWorkItemId(
    workItemId: WorkItemId,
    dbExecutor?: DbExecutor,
  ): Promise<ResolvedWorkItemAutomation[]>;
  /** Inserts the attachment; returns the existing one when it's already attached. */
  insert(
    attachment: WorkItemAutomationEntity,
    dbExecutor?: DbExecutor,
  ): Promise<WorkItemAutomationEntity>;
  /** Returns whether an attachment was deleted. */
  delete(
    workItemId: WorkItemId,
    automationId: UuidV7,
    dbExecutor?: DbExecutor,
  ): Promise<boolean>;
};
