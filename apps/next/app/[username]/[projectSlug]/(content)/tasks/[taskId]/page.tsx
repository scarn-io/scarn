import { redirect } from "next/navigation";
import { parseUuidV7 } from "@scarn/api/frontend-contracts";
import {
  getScarnApiClient,
  getScarnApiRequestHeaders,
} from "@/app/_lib/scarn-api-client";
import { legacyTaskHref } from "@/components/runs/legacy-run-redirects";

async function loadTaskOwner(taskId: string) {
  let id: string;
  try {
    id = parseUuidV7(taskId);
  } catch {
    return null;
  }
  const scarnApiClient = await getScarnApiClient();
  const { data } = await scarnApiClient.api
    .tasks({ taskId: id })
    .get({ headers: await getScarnApiRequestHeaders() });
  return data ?? null;
}

export default async function LegacyProjectTaskPage({
  params,
}: {
  params: Promise<{ username: string; projectSlug: string; taskId: string }>;
}) {
  const { username, projectSlug, taskId } = await params;
  redirect(
    legacyTaskHref(username, projectSlug, taskId, await loadTaskOwner(taskId)),
  );
}
