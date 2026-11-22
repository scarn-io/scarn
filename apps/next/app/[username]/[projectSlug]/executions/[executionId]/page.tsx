import { redirect } from "next/navigation";
import {
  legacyExecutionHref,
  type LegacySearchParams,
} from "@/components/runs/legacy-run-redirects";

export default async function LegacyExecutionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{
    username: string;
    projectSlug: string;
    executionId: string;
  }>;
  searchParams: Promise<LegacySearchParams>;
}) {
  const { username, projectSlug, executionId } = await params;
  redirect(
    legacyExecutionHref(username, projectSlug, executionId, await searchParams),
  );
}
