import { redirect } from "next/navigation";
import { projectSubPath } from "@/app/(protected)/projects/_lib/project-routing";

/** Notifications moved into the Inbox; old links land there. */
export default async function ProjectNotificationsPage({
  params,
}: {
  params: Promise<{ username: string; projectSlug: string }>;
}) {
  const { username, projectSlug } = await params;
  redirect(projectSubPath(username, projectSlug, "inbox"));
}
