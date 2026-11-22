import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import { normalizeDate } from "@scarn/core/work-items/work-item/domain/date-utils";
import {
  parseWorkItemId,
  type WorkItemId,
} from "@scarn/core/work-items/work-item/domain/work-item-id";

export type WorkItemAutomationEntityProps = {
  workItemId: WorkItemId;
  automationId: UuidV7;
  attachedByUserId: UuidV7;
  attachedAt: Date | string;
};

/**
 * A work-item automation attached to a work item. It isn't pinned to a
 * version: it always runs the automation's latest published version.
 */
export class WorkItemAutomationEntity {
  public readonly workItemId: WorkItemId;
  public readonly automationId: UuidV7;
  public readonly attachedByUserId: UuidV7;
  public readonly attachedAt: Date;

  private constructor(props: WorkItemAutomationEntityProps) {
    const attachedAt = normalizeDate(props.attachedAt);
    if (!attachedAt) {
      throw new CoreValidationError(
        "An attachment needs an attach time",
        "WORK_ITEM_AUTOMATION_ATTACHED_AT_REQUIRED",
      );
    }
    this.workItemId = parseWorkItemId(props.workItemId);
    this.automationId = parseUuidV7(props.automationId);
    this.attachedByUserId = parseUuidV7(props.attachedByUserId);
    this.attachedAt = attachedAt;
  }

  static create(
    props: WorkItemAutomationEntityProps,
  ): WorkItemAutomationEntity {
    return new WorkItemAutomationEntity(props);
  }

  static rehydrate(
    props: WorkItemAutomationEntityProps,
  ): WorkItemAutomationEntity {
    return new WorkItemAutomationEntity(props);
  }
}
