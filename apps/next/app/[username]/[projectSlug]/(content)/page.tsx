import { redirect } from "next/navigation";
import {
  DEMO_ACCOUNT_USERNAME,
  DEMO_PROJECT_SLUG,
} from "@scarn/core/demo-project/demo-account";
import { projectSubPath } from "@/app/(protected)/projects/_lib/project-routing";

/**
 * The project root has no page of its own — it always redirects one hop
 * further in. Every project except the seeded demo lands on Work Items;
 * the demo project's Overview/guest-tour experience lives at `/tour`
 * (`(content)/tour/page.tsx`) instead, so the landing site's CTA and the
 * demo's own guest tour still get a real page to point at.
 *
 * The redirect target is decided from the route's own `username`/
 * `projectSlug` params — the same "derive demo-ness from live route params"
 * convention `project-conversion-banner.tsx` uses — so this never costs a
 * project fetch of its own: the layout has already spent the one fetch this
 * whole subtree needs to gate the route.
 */
export default async function ProjectRootPage({
  params,
}: {
  params: Promise<{ username: string; projectSlug: string }>;
}) {
  const { username, projectSlug } = await params;
  const isDemoProject =
    username === DEMO_ACCOUNT_USERNAME && projectSlug === DEMO_PROJECT_SLUG;

  redirect(
    projectSubPath(username, projectSlug, isDemoProject ? "tour" : "work-items"),
  );
}
