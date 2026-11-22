// Server-only helpers — imports next/headers via getScarnApiClient.
// Do NOT import this file from "use client" components.
import { getScarnApiClient } from "@/app/_lib/scarn-api-client";
import type { ProjectContract } from "@scarn/api/frontend-contracts";

export async function loadProject(
  projectId: string,
  requestHeaders: Record<string, string>,
) {
  const scarnApiClient = await getScarnApiClient();
  const { data } = await scarnApiClient.api.projects({ projectId }).get({
    headers: requestHeaders,
  });

  if (!data) {
    throw new Error("Project not found");
  }

  return data;
}

/**
 * Resolve a pretty URL `/{username}/{projectSlug}` to the project. Returns null
 * on any resolution miss (unknown username/slug, stale username after a rename,
 * or no access) so callers can `notFound()` — matching the hard-404 decision.
 */
export async function resolveProjectBySlug(
  username: string,
  projectSlug: string,
  requestHeaders: Record<string, string>,
) {
  const scarnApiClient = await getScarnApiClient();
  const { data } = await scarnApiClient.api.projects.resolve.get({
    query: { username, slug: projectSlug },
    headers: requestHeaders,
  });

  return data ?? null;
}

/** Distinguishes "no session" from "not found/forbidden" for the project route
 * layout, which must redirect the former to `/login` but hard-404 the latter
 * — the same 401-vs-403/404 split `assertProjectPermission` enforces
 * server-side (see issue #149). Every other page under a resolved project
 * uses the simpler {@link resolveProjectBySlug} above instead, since by the
 * time they run, the layout has already settled this question.
 */
export type ProjectAccessResult =
  | { status: "ok"; project: ProjectContract }
  | { status: "unauthenticated" }
  | { status: "not-found" };

export async function resolveProjectAccessBySlug(
  username: string,
  projectSlug: string,
  requestHeaders: Record<string, string>,
): Promise<ProjectAccessResult> {
  const scarnApiClient = await getScarnApiClient();
  const { data, error } = await scarnApiClient.api.projects.resolve.get({
    query: { username, slug: projectSlug },
    headers: requestHeaders,
  });

  if (data) {
    return { status: "ok", project: data };
  }

  const errorStatus = "status" in error ? error.status : undefined;

  return errorStatus === 401
    ? { status: "unauthenticated" }
    : { status: "not-found" };
}
