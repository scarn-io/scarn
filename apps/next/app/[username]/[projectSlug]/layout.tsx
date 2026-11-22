import { notFound, redirect } from "next/navigation";
import { Box } from "@mui/material";
import {
  DEMO_ACCOUNT_USERNAME,
  DEMO_PROJECT_SLUG,
} from "@scarn/core/demo-project/demo-account";
import { AppShell } from "@/components/app-shell";
import { ProjectTabsBar } from "@/components/project-tabs-bar";
import { ProjectConversionBanner } from "@/components/project-conversion-banner";
import { ProjectRouteProvider } from "@/components/project-route-context";
import { resolveProjectAccessBySlug } from "@/app/(protected)/projects/_lib/project-work-items-server";
import { getScarnApiRequestHeaders } from "@/app/_lib/scarn-api-client";
import { getServerSession } from "@/app/_lib/auth";
import { isProjectMember } from "@/app/_lib/project-membership";
import {
  loginRedirectPath,
  onboardingRedirectPath,
} from "@/app/_lib/callback-url";

// This route tree is deliberately NOT under `(protected)`: a public project's
// work items, executions, logs, artifacts, and comments must be reachable by
// a fully anonymous visitor (issue #150), which the blanket
// `(protected)/layout.tsx` session redirect would otherwise block before this
// layout ever gets a chance to check the project's own visibility. This
// layout is therefore the sole gate for the whole `/{username}/{projectSlug}`
// subtree and reimplements the two pieces of `(protected)/layout.tsx` this
// tree still needs: the onboarding redirect and the `AppShell` chrome.
export const dynamic = "force-dynamic";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ username: string; projectSlug: string }>;
}) {
  const { username, projectSlug } = await params;
  const session = await getServerSession();

  // Mirrors `(protected)/layout.tsx`: a signed-in user who hasn't chosen a
  // username yet is sent to onboarding on every page, project pages included.
  if (session && !session.user.usernameChosen) {
    redirect(await onboardingRedirectPath());
  }

  const requestHeaders = await getScarnApiRequestHeaders();
  const resolution = await resolveProjectAccessBySlug(
    username,
    projectSlug,
    requestHeaders,
  );

  // No session at all, and the project didn't grant a public-read fallback
  // (i.e. it's private, or doesn't exist) — same outcome as today, where
  // `(protected)/layout.tsx` redirects before a private project is ever
  // considered.
  if (resolution.status === "unauthenticated") {
    redirect(await loginRedirectPath());
  }

  // Unknown project, or a logged-in non-member of a private project — hard
  // 404, exactly as today.
  if (resolution.status === "not-found") {
    notFound();
  }

  const { project } = resolution;
  const isMember = isProjectMember(project, session?.user.id);
  const viewerMembership = project.memberships.find(
    (m) => m.userId === session?.user.id,
  );
  const role = viewerMembership?.role ?? null;
  const permissions = viewerMembership?.permissions ?? [];
  const isDemoProject =
    username === DEMO_ACCOUNT_USERNAME && project.slug === DEMO_PROJECT_SLUG;

  return (
    <AppShell initialUser={session?.user ?? null}>
      <ProjectRouteProvider
        username={username}
        projectSlug={project.slug}
        projectId={project.id}
        isMember={isMember}
        role={role}
        permissions={permissions}
      >
        <ProjectTabsBar
          username={username}
          projectSlug={project.slug}
          projectName={project.name}
          orgId={project.orgId}
          projectId={project.id}
          isMember={isMember}
          isDemoProject={isDemoProject}
        />
        <ProjectConversionBanner />
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {children}
        </Box>
      </ProjectRouteProvider>
    </AppShell>
  );
}
