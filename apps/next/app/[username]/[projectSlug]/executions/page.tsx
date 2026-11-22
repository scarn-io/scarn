import { redirect } from "next/navigation";
import {
  legacyExecutionsHref,
  type LegacySearchParams,
} from "@/components/runs/legacy-run-redirects";

export default async function LegacyProjectExecutionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ username: string; projectSlug: string }>;
  searchParams: Promise<LegacySearchParams>;
}) {
  const { username, projectSlug } = await params;
  redirect(legacyExecutionsHref(username, projectSlug, await searchParams));
}
