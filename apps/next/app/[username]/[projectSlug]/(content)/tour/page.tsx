import { notFound } from "next/navigation";
import {
  DEMO_ACCOUNT_USERNAME,
  DEMO_PROJECT_SLUG,
} from "@scarn/core/demo-project/demo-account";
import { getServerSession } from "@/app/_lib/auth";
import { getScarnApiRequestHeaders } from "@/app/_lib/scarn-api-client";
import { resolveProjectBySlug } from "@/app/(protected)/projects/_lib/project-work-items-server";
import {
  loadProjectOverviewCounts,
  loadProjectOverviewTour,
} from "@/app/(protected)/projects/_lib/project-overview-server";
import { isProjectMember } from "@/app/_lib/project-membership";
import { PageHeader } from "@/components/page-header";
import { ProjectOverviewGuestTour } from "@/components/projects/project-overview-guest-tour";
import { ProjectOverviewMemberSummary } from "@/components/projects/project-overview-member-summary";

/**
 * The project Overview (`docs/demo-showcase-implementation-plan.md` Phase 5a).
 *
 * Lives at `/tour` rather than the project root: the root now always
 * redirects (`(content)/page.tsx`), landing members straight on Work Items.
 * Only the seeded demo project's root redirects here instead, since this is
 * still the landing site's highest-intent CTA target and the demo's guest
 * tour needs a real page to live at (see `project-tabs-bar.tsx`, which only
 * shows the Overview tab for the demo project, and `project-conversion-banner.tsx`
 * and `login-card.tsx`, which link straight here for the demo).
 *
 * Deliberately demo-only: this hard-404s any other project rather than
 * rendering the same summary/guest-tour content for it. `/tour` isn't a
 * general-purpose page any project can opt into by URL — it's the demo's
 * page, parked at a segment instead of the root.
 *
 * Membership is resolved here with the server-side `isProjectMember` rather than
 * read from `ProjectRouteContext`, which is a client hook: keeping this a server
 * component is what lets the guest tour's targets be resolved with server-side
 * requests instead of a waterfall of browser fetches.
 */
export default async function ProjectTourPage({
  params,
}: {
  params: Promise<{ username: string; projectSlug: string }>;
}) {
  const { username, projectSlug } = await params;

  if (
    username !== DEMO_ACCOUNT_USERNAME ||
    projectSlug !== DEMO_PROJECT_SLUG
  ) {
    notFound();
  }

  const session = await getServerSession();
  const requestHeaders = await getScarnApiRequestHeaders();
  const project = await resolveProjectBySlug(
    username,
    projectSlug,
    requestHeaders,
  );

  if (!project) {
    notFound();
  }

  if (isProjectMember(project, session?.user.id)) {
    const counts = await loadProjectOverviewCounts(project, requestHeaders);

    return (
      <>
        <PageHeader
          title="Overview"
          description="Where this project stands right now."
        />
        <ProjectOverviewMemberSummary
          username={username}
          projectSlug={project.slug}
          counts={counts}
        />
      </>
    );
  }

  const tour = await loadProjectOverviewTour(project.id, requestHeaders);

  return (
    <>
      <PageHeader
        eyebrow="Read-only tour"
        title={project.name}
        description="A live project you can read end to end: real work items, real agent runs, real logs and traces. Start with one of these."
      />
      <ProjectOverviewGuestTour
        username={username}
        projectSlug={project.slug}
        tour={tour}
      />
    </>
  );
}
