import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import type { WorkItemEntity } from "@scarn/core/work-items/work-item/domain/work-item-entity";
import type { AutomationEntity } from "../domain/automation-entity";
import { WorkItemAutomationEntity } from "../domain/work-item-automation-entity";
import type { WorkItemAutomationRepo } from "./work-item-automation-repo";

export type AttachAutomationDeps = {
  workItemAutomationRepo: WorkItemAutomationRepo;
};

/**
 * Attaches `automation` to `workItem` unless it's already attached. Returns
 * whether this call made the attachment: only a new attachment fires
 * `self.attached`. Scope and state checks are the caller's.
 */
export const attachAutomation = async (
  workItem: WorkItemEntity,
  automation: AutomationEntity,
  attachment: { attachedByUserId: UuidV7; attachedAt: Date },
  deps: AttachAutomationDeps,
  tx: DbExecutor,
): Promise<boolean> => {
  const existing = await deps.workItemAutomationRepo.load(
    workItem.id,
    automation.id,
    tx,
  );
  if (existing) {
    return false;
  }
  await deps.workItemAutomationRepo.insert(
    WorkItemAutomationEntity.create({
      workItemId: workItem.id,
      automationId: automation.id,
      ...attachment,
    }),
    tx,
  );
  return true;
};
