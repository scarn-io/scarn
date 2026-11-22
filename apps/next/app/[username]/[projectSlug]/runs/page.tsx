import { getScarnApiRequestHeaders } from "@/app/_lib/scarn-api-client";
import { resolveProjectBySlug } from "@/app/(protected)/projects/_lib/project-work-items-server";
import { RunsList } from "@/components/runs/runs-list";
import { notFound } from "next/navigation";

/**
 * The Runs tab. No session check: a public project's guests see runs like
 * they see executions; the project layout has already settled visibility.
 * Every filter lives in the URL and is read on the client.
 */
export default async function ProjectRunsPage({
  params,
}: {
  params: Promise<{ username: string; projectSlug: string }>;
}) {
  const { username, projectSlug } = await params;

  const project = await resolveProjectBySlug(
    username,
    projectSlug,
    await getScarnApiRequestHeaders(),
  );

  if (!project) {
    notFound();
  }

  return <RunsList projectId={project.id} />;
}
