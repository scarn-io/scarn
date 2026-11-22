import { redirectToConversationTask } from "@/app/[username]/[projectSlug]/_lib/conversation-task-redirect";

export default async function LegacyProjectRunChatPage({
  params,
}: {
  params: Promise<{
    username: string;
    projectSlug: string;
    conversationId: string;
  }>;
}) {
  const { username, projectSlug, conversationId } = await params;
  return redirectToConversationTask(username, projectSlug, conversationId);
}
