import { notFound } from "next/navigation";
import { getServerSession } from "@/app/_lib/auth";
import {
  getScarnApiClient,
  getScarnApiRequestHeaders,
} from "@/app/_lib/scarn-api-client";
import { resolveProjectBySlug } from "@/app/(protected)/projects/_lib/project-work-items-server";
import { isProjectMember } from "@/app/_lib/project-membership";
import { PageHeader } from "@/components/page-header";
import { ProjectInbox } from "@/components/inbox/project-inbox";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import type { UserNotificationContract } from "@scarn/api/frontend-contracts";

// The inbox is per-user and member-only (issue #150) — meaningless for an
// anonymous viewer and out of scope for a non-member, so this requires real
// membership rather than a public project's read fallback.
export default async function ProjectInboxPage({
  params,
}: {
  params: Promise<{ username: string; projectSlug: string }>;
}) {
  const session = await getServerSession();
  const { username, projectSlug } = await params;
  const requestHeaders = await getScarnApiRequestHeaders();

  const project = await resolveProjectBySlug(
    username,
    projectSlug,
    requestHeaders,
  );
  if (!project || !isProjectMember(project, session?.user.id)) notFound();

  try {
    const scarnApiClient = await getScarnApiClient();
    const notificationsResponse = await scarnApiClient.api
      .projects({ projectId: parseUuidV7(project.id) })
      .notifications.get({ headers: requestHeaders });

    const initialNotifications: UserNotificationContract[] = Array.isArray(
      notificationsResponse.data,
    )
      ? notificationsResponse.data
      : [];

    return (
      <>
        <PageHeader
          title="Inbox"
          description="Agents and pipeline runs waiting on you, agent work you started that stopped, and the agent's other notifications."
        />
        <ProjectInbox
          projectId={project.id}
          initialNotifications={initialNotifications}
        />
      </>
    );
  } catch {
    notFound();
  }
}
