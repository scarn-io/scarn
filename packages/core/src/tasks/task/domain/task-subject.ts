import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";

export type TaskSubject = {
  workItemId: UuidV7 | null;
  conversationId: UuidV7 | null;
  startedByScheduleId: UuidV7 | null;
};

/**
 * What a Task is about and who owns it: its work item, else (for a chat
 * Task) its conversation, else (for a scheduled Task) the schedule that
 * started it. A Task has at least one of them, as `tasks` enforces with
 * `tasks_owner_check`.
 */
export const validTaskSubject = (subject: {
  workItemId: string | null;
  conversationId: string | null;
  startedByScheduleId: string | null;
}): TaskSubject => {
  const { workItemId, conversationId, startedByScheduleId } = subject;
  if (
    workItemId === null &&
    conversationId === null &&
    startedByScheduleId === null
  ) {
    throw new CoreValidationError(
      "A Task needs a work item, a conversation or a schedule",
      "TASK_OWNER_REQUIRED",
    );
  }
  return {
    workItemId: workItemId === null ? null : parseUuidV7(workItemId),
    conversationId:
      conversationId === null ? null : parseUuidV7(conversationId),
    startedByScheduleId:
      startedByScheduleId === null ? null : parseUuidV7(startedByScheduleId),
  };
};
