import { redirect } from "next/navigation";
import { legacyNewConversationHref } from "@/components/runs/legacy-run-redirects";

export default async function LegacyNewProjectConversationPage({
  params,
}: {
  params: Promise<{ username: string; projectSlug: string }>;
}) {
  const { username, projectSlug } = await params;
  redirect(legacyNewConversationHref(username, projectSlug));
}
