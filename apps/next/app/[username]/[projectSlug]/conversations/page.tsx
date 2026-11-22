import { redirect } from "next/navigation";
import { legacyConversationsHref } from "@/components/runs/legacy-run-redirects";

export default async function LegacyProjectConversationsPage({
  params,
}: {
  params: Promise<{ username: string; projectSlug: string }>;
}) {
  const { username, projectSlug } = await params;
  redirect(legacyConversationsHref(username, projectSlug));
}
