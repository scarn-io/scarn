import { getServerSession } from "@/app/_lib/auth";
import { getScarnApiRequestHeaders } from "@/app/_lib/scarn-api-client";
import { resolveProjectBySlug } from "@/app/(protected)/projects/_lib/project-work-items-server";
import { isProjectMember } from "@/app/_lib/project-membership";
import { PageHeader } from "@/components/page-header";
import { CreateWorkItemForm } from "@/components/work-items/create-work-item-form";
import { notFound } from "next/navigation";

// Creating a work item is a write action, so — unlike the read-only
// `work-items/page.tsx` — this page requires real membership, not merely a
// public project's read-access fallback (issue #150). A non-member never
// sees the "New work item" button that links here (`project-work-items-client.tsx`),
// but this still 404s a direct hit.
export default async function NewProjectWorkItemPage({
  params,
}: {
  params: Promise<{ username: string; projectSlug: string }>;
}) {
  const session = await getServerSession();
  const { username, projectSlug } = await params;
  const project = await resolveProjectBySlug(
    username,
    projectSlug,
    await getScarnApiRequestHeaders(),
  );

  if (!project || !isProjectMember(project, session?.user.id)) {
    notFound();
  }

  return (
    <>
      <PageHeader
        title="New work item"
        description="Describe the work in enough detail for the agent to act on it."
      />
      <CreateWorkItemForm projectId={project.id} />
    </>
  );
}
