import {
  createUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import type { WorkItemId } from "@scarn/core/work-items/work-item/domain/work-item-id";

export const WORK_ITEM_ACTIVITY_KINDS = ["automation"] as const;
export type WorkItemActivityKind = (typeof WORK_ITEM_ACTIVITY_KINDS)[number];

export type WorkItemActivityEntryProps = {
  id: UuidV7;
  projectId: UuidV7;
  workItemId: WorkItemId;
  kind: WorkItemActivityKind;
  message: string;
  createdAt: Date;
};

/**
 * One line of a work item's activity: something the system did about the
 * item. Automations log what each rule started, skipped or failed to start.
 * Never changes once written.
 */
export class WorkItemActivityEntry {
  public readonly id: UuidV7;
  public readonly projectId: UuidV7;
  public readonly workItemId: WorkItemId;
  public readonly kind: WorkItemActivityKind;
  public readonly message: string;
  public readonly createdAt: Date;

  private constructor(props: WorkItemActivityEntryProps) {
    if (props.message.trim().length === 0) {
      throw new CoreValidationError(
        "An activity line needs a message",
        "WORK_ITEM_ACTIVITY_MESSAGE_REQUIRED",
      );
    }
    this.id = props.id;
    this.projectId = props.projectId;
    this.workItemId = props.workItemId;
    this.kind = props.kind;
    this.message = props.message;
    this.createdAt = props.createdAt;
  }

  static create(
    props: Omit<WorkItemActivityEntryProps, "id">,
  ): WorkItemActivityEntry {
    return new WorkItemActivityEntry({ ...props, id: createUuidV7() });
  }

  static rehydrate(props: WorkItemActivityEntryProps): WorkItemActivityEntry {
    return new WorkItemActivityEntry(props);
  }
}
