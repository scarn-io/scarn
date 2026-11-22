/**
 * The old chat URLs (`conversations/[id]`, `runs/chats/[id]`) redirect to the
 * chat's Task page; a chat that can't be read 404s.
 */
import { notFound, redirect } from "next/navigation";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import {
  getScarnApiClient,
  getScarnApiRequestHeaders,
} from "@/app/_lib/scarn-api-client";
import { legacyConversationHref } from "@/components/runs/legacy-run-redirects";

async function loadConversation(conversationId: string) {
  let id: string;
  try {
    id = parseUuidV7(conversationId);
  } catch {
    return null;
  }
  const scarnApiClient = await getScarnApiClient();
  const { data } = await scarnApiClient.api
    .conversations({ conversationId: id })
    .get({ headers: await getScarnApiRequestHeaders() });
  return data ?? null;
}

export async function redirectToConversationTask(
  username: string,
  projectSlug: string,
  conversationId: string,
): Promise<never> {
  const href = legacyConversationHref(
    username,
    projectSlug,
    await loadConversation(conversationId),
  );
  if (href === null) notFound();
  redirect(href);
}
