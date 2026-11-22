import { parseUuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { ResourceNotFoundError } from "@scarn/core/lib/errors";
import { Result } from "@scarn/core/lib/result";
import {
  retryTask,
  type RetryTaskDeps,
} from "@scarn/core/tasks/task/application/retry-task";
import type { RetriedTaskContract } from "@scarn/core/tasks/task/contracts/task-contracts";
import {
  retryRepoConversationInputSchema,
  type RetryRepoConversationInput,
} from "../contracts/conversation-contracts";
import type { RepoConversationReader } from "./repo-conversation-reader";

/**
 * Retries a chat's failed turn: `retryTask` on its Task, guarded by the
 * latest run the caller saw (409 when stale, so two concurrent retries make
 * one run) and refused once the chat ended (409 `CONVERSATION_ENDED`). 404
 * when the conversation isn't a chat.
 */
export const retryRepoConversation = async (
  input: RetryRepoConversationInput,
  deps: RetryTaskDeps & { repoConversationReader: RepoConversationReader },
): Promise<Result<RetriedTaskContract, ResourceNotFoundError>> => {
  const { conversationId, expectedLatestRunId } =
    retryRepoConversationInputSchema.parse(input);
  const chat = await deps.repoConversationReader.loadByConversationId(
    parseUuidV7(conversationId),
    deps.dbExecutor,
  );
  if (!chat) {
    return Result.err(
      new ResourceNotFoundError("Conversation", conversationId),
    );
  }
  return await retryTask({ taskId: chat.taskId, expectedLatestRunId }, deps);
};
