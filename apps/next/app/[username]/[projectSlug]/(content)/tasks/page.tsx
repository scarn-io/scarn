import { redirect } from "next/navigation";
import {
  legacyTasksHref,
  type LegacySearchParams,
} from "@/components/runs/legacy-run-redirects";

export default async function LegacyProjectTasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ username: string; projectSlug: string }>;
  searchParams: Promise<LegacySearchParams>;
}) {
  const { username, projectSlug } = await params;
  redirect(legacyTasksHref(username, projectSlug, await searchParams));
}
