import { notFound } from "next/navigation";
import { ProjectWorkItemsClient } from "@/components/work-items/project-work-items-client";
import { SyncFailedFlash } from "@/components/work-items/sync-failed-flash";
import { UnsavedTokenFlash } from "@/components/work-items/unsaved-token-flash";
import { resolveProjectBySlug } from "@/app/(protected)/projects/_lib/project-work-items-server";
import { getScarnApiRequestHeaders } from "@/app/_lib/scarn-api-client";

export default async function ProjectWorkItemsPage({
  params,
}: {
  params: Promise<{ username: string; projectSlug: string }>;
}) {
  const { username, projectSlug } = await params;
  const requestHeaders = await getScarnApiRequestHeaders();
  const project = await resolveProjectBySlug(
    username,
    projectSlug,
    requestHeaders,
  );

  if (!project) {
    notFound();
  }

  return (
    <>
      <SyncFailedFlash />
      <UnsavedTokenFlash />
      <ProjectWorkItemsClient projectId={project.id} />
    </>
  );
}
