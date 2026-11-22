import { notFound, redirect } from "next/navigation";
import { getServerSession } from "@/app/_lib/auth";
import { isDemoProjectEnabled } from "@/app/_lib/demo-project";
import { ProjectsDashboardPageClient } from "@/components/projects/projects-dashboard-page-client";

export default async function HomePage() {
  const session = await getServerSession();
  if (!session) notFound();
  // The protected layout guarantees onboarded users here (non-null username),
  // but narrow explicitly so the client contract stays non-null.
  if (session.user.username == null) redirect("/onboarding/username");

  return (
    <ProjectsDashboardPageClient
      username={session.user.username}
      showDemoLink={isDemoProjectEnabled()}
    />
  );
}
