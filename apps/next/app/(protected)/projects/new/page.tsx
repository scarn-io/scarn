import { notFound, redirect } from "next/navigation";
import { getGitHubAppConfig } from "@scarn/identity";
import { getServerSession } from "@/app/_lib/auth";
import { ProjectsNewPageClient } from "@/components/projects/new/projects-new-page-client";

// Thin server shell: only `session.user.username` (identity) and
// `githubAppConfigured` (server-only config, not user data) are read here.
// Everything else (the repo check and the wizard's steps) is client-side.
export default async function NewProjectPage() {
  const session = await getServerSession();
  if (!session) notFound();
  // The protected layout guarantees onboarded users here (non-null username),
  // but narrow explicitly so the client contract stays non-null.
  if (session.user.username == null) redirect("/onboarding/username");

  const githubAppConfigured = getGitHubAppConfig() !== null;

  return (
    <ProjectsNewPageClient
      username={session.user.username}
      githubAppConfigured={githubAppConfigured}
    />
  );
}
