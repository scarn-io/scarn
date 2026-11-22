import type { TaskMessageContract } from "../contracts/task-message-contracts";
import type { TaskMessageEntity } from "../domain/task-message-entity";

export const taskMessageEntityToContract = (
  message: TaskMessageEntity,
): TaskMessageContract => ({
  id: message.id,
  taskId: message.taskId,
  authorUserId: message.authorUserId,
  body: message.body,
  quoteText: message.quoteText,
  createdAt: (message.createdAt ?? new Date(0)).toISOString(),
});
