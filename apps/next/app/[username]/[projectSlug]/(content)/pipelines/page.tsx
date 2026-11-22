import { getServerSession } from "@/app/_lib/auth";
import { getScarnApiRequestHeaders } from "@/app/_lib/scarn-api-client";
import { resolveProjectBySlug } from "@/app/(protected)/projects/_lib/project-work-items-server";
import { isProjectMember } from "@/app/_lib/project-membership";
import { PipelinePageTabs } from "@/components/pipelines/pipeline-page-tabs";
import { notFound } from "next/navigation";

const getSingleValue = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

// Pipeline configuration is a member-only area (issue #150): the read-only
// spec only asks for work items, executions, and comments, and this page is
// mostly write affordances for the pipeline builder. Requires real
// membership, not just a public project's read fallback.
export default async function ProjectPipelinesPage({
  params,
  searchParams,
}: {
  params: Promise<{ username: string; projectSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getServerSession();
  const { username, projectSlug } = await params;
  const resolvedSearchParams = await searchParams;

  const project = await resolveProjectBySlug(
    username,
    projectSlug,
    await getScarnApiRequestHeaders(),
  );

  if (!project || !isProjectMember(project, session?.user.id)) {
    notFound();
  }

  return (
    <PipelinePageTabs
      projectId={project.id}
      projectRef={`${project.ownerUsername ?? username}/${project.slug}`}
      selectedPipelineDefinitionId={
        getSingleValue(resolvedSearchParams["pipelineDefinitionId"]) ?? null
      }
    />
  );
}
