import { CoreValidationError } from "@scarn/core/lib/errors";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { normalizeDate } from "./date-utils";

export const WORK_ITEM_CLOSE_REASONS = [
  "completed",
  "out_of_scope",
  "superseded",
] as const;

export type WorkItemCloseReason = (typeof WORK_ITEM_CLOSE_REASONS)[number];

/**
 * How a closed work item was closed. Every closed item has one and an open
 * item never does: reopening clears it. `resolution` is what readers use as
 * the item's outcome, whoever closed it. A sync close has reason `completed`,
 * no resolution and no closer.
 */
export type WorkItemClosure = {
  reason: WorkItemCloseReason;
  resolution: string | null;
  closedAt: Date;
  closedByUserId: UuidV7 | null;
  closedByTaskId: UuidV7 | null;
};

export type WorkItemClosureProps = Omit<WorkItemClosure, "closedAt"> & {
  closedAt: Date | string;
};

export const syncWorkItemClosure = (closedAt: Date): WorkItemClosure => ({
  reason: "completed",
  resolution: null,
  closedAt,
  closedByUserId: null,
  closedByTaskId: null,
});

export const normalizeWorkItemClosure = (
  props: WorkItemClosureProps,
): WorkItemClosure => {
  const closedAt = normalizeDate(props.closedAt);
  if (!closedAt) {
    throw new CoreValidationError(
      "A closed work item needs a valid closedAt",
      "WORK_ITEM_CLOSED_AT_INVALID",
    );
  }
  if (props.closedByUserId && props.closedByTaskId) {
    throw new CoreValidationError(
      "A work item is closed by a user or a Task, not both",
      "WORK_ITEM_CLOSED_BY_CONFLICT",
    );
  }

  return {
    reason: props.reason,
    resolution: props.resolution?.trim() || null,
    closedAt,
    closedByUserId: props.closedByUserId
      ? parseUuidV7(props.closedByUserId)
      : null,
    closedByTaskId: props.closedByTaskId
      ? parseUuidV7(props.closedByTaskId)
      : null,
  };
};
