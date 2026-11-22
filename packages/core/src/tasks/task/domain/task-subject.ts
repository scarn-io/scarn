import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";

/**
 * What a Task is about: its work item, else (for a chat Task) its
 * conversation. A Task has at least one of them, as `tasks` enforces with
 * `tasks_work_item_or_conversation_check`.
 */
export const validTaskSubject = (
  workItemId: string | null,
  conversationId: string | null,
): { workItemId: UuidV7 | null; conversationId: UuidV7 | null } => {
  if (workItemId === null && conversationId === null) {
    throw new CoreValidationError(
      "A Task needs a work item or a conversation",
      "TASK_WORK_ITEM_OR_CONVERSATION_REQUIRED",
    );
  }
  return {
    workItemId: workItemId === null ? null : parseUuidV7(workItemId),
    conversationId:
      conversationId === null ? null : parseUuidV7(conversationId),
  };
};
