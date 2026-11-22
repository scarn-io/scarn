/**
 * Browser fetchers for repo conversations (project chats): opening a chat, reading one, and its reply, retry, end and delete
 * actions.
 */
import {
  parseUuidV7,
  type ConversationContract,
  type RepoConversationState,
} from "@scarn/api/frontend-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { unwrapTreatyResponse } from "@/app/_lib/scarn-treaty";

export type RepoConversation = ConversationContract;
export type { RepoConversationState };

export const REPO_CONVERSATION_STATE_LABELS: Record<
  RepoConversationState,
  string
> = {
  queued: "Queued",
  running: "Working",
  retry_queued: "Retry queued",
  waiting: "Waiting for a reply",
  failed: "Failed",
  ended: "Ended",
};

const conversationRoute = (conversationId: string) =>
  getBrowserScarnApiClient().api.conversations({
    conversationId: parseUuidV7(conversationId),
  });

export async function createRepoConversation(
  projectId: string,
  body: string,
): Promise<RepoConversation> {
  return await unwrapTreatyResponse(
    getBrowserScarnApiClient()
      .api.projects({ projectId: parseUuidV7(projectId) })
      .conversations.post({ body }),
  );
}

export async function fetchRepoConversation(
  conversationId: string,
): Promise<RepoConversation> {
  return await unwrapTreatyResponse(conversationRoute(conversationId).get());
}

export async function replyToRepoConversation(
  conversationId: string,
  body: string,
): Promise<RepoConversation> {
  return await unwrapTreatyResponse(
    conversationRoute(conversationId).messages.post({ body }),
  );
}

export async function retryRepoConversation(
  conversationId: string,
  expectedLatestRunId: string | null,
): Promise<RepoConversation> {
  return await unwrapTreatyResponse(
    conversationRoute(conversationId).retry.post({
      expectedLatestRunId:
        expectedLatestRunId === null ? null : parseUuidV7(expectedLatestRunId),
    }),
  );
}

export async function endRepoConversation(
  conversationId: string,
): Promise<RepoConversation> {
  return await unwrapTreatyResponse(
    conversationRoute(conversationId).end.post(),
  );
}

export async function deleteRepoConversation(
  conversationId: string,
): Promise<void> {
  await unwrapTreatyResponse(conversationRoute(conversationId).delete());
}
