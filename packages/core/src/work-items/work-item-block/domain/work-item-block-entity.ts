import { CoreValidationError } from "@scarn/core/lib/errors";
import {
  parseUuidV7,
  type UuidV7,
} from "@scarn/core/common/contracts/uuid-v7";
import { normalizeDate } from "./date-utils";
import {
  createWorkItemBlockId,
  parseWorkItemBlockId,
  type WorkItemBlockId,
} from "./work-item-block-id";

export type WorkItemBlockEntityProps = {
  id: WorkItemBlockId;
  projectId: UuidV7;
  // The item that cannot proceed until the blocker is resolved.
  blockedWorkItemId: UuidV7;
  // The item that must be resolved first.
  blockingWorkItemId: UuidV7;
  createdByUserId?: UuidV7 | null | undefined;
  createdAt?: Date | string | null | undefined;
};

export type CreateWorkItemBlockProps = Omit<
  WorkItemBlockEntityProps,
  "id" | "createdAt"
> & {
  id?: WorkItemBlockId | undefined;
};

export class WorkItemBlockEntity {
  public readonly id: WorkItemBlockId;
  public readonly projectId: UuidV7;
  public readonly blockedWorkItemId: UuidV7;
  public readonly blockingWorkItemId: UuidV7;
  public readonly createdByUserId: UuidV7 | null;
  public readonly createdAt: Date | null | undefined;

  private constructor(props: WorkItemBlockEntityProps) {
    const blockedWorkItemId = parseUuidV7(props.blockedWorkItemId);
    const blockingWorkItemId = parseUuidV7(props.blockingWorkItemId);

    if (blockedWorkItemId === blockingWorkItemId) {
      throw new CoreValidationError(
        "A work item cannot block itself",
        "WORK_ITEM_SELF_BLOCK",
      );
    }

    this.id = parseWorkItemBlockId(props.id);
    this.projectId = parseUuidV7(props.projectId);
    this.blockedWorkItemId = blockedWorkItemId;
    this.blockingWorkItemId = blockingWorkItemId;
    this.createdByUserId = props.createdByUserId
      ? parseUuidV7(props.createdByUserId)
      : null;
    this.createdAt = normalizeDate(props.createdAt);
  }

  static create(props: CreateWorkItemBlockProps): WorkItemBlockEntity {
    return new WorkItemBlockEntity({
      ...props,
      id: props.id ?? createWorkItemBlockId(),
    });
  }

  static rehydrate(props: WorkItemBlockEntityProps): WorkItemBlockEntity {
    return new WorkItemBlockEntity(props);
  }

  toJSON(): WorkItemBlockEntityProps {
    return {
      id: this.id,
      projectId: this.projectId,
      blockedWorkItemId: this.blockedWorkItemId,
      blockingWorkItemId: this.blockingWorkItemId,
      createdByUserId: this.createdByUserId,
      createdAt: this.createdAt,
    };
  }
}
