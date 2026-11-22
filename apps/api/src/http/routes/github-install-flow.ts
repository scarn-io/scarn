import { DrizzleAuthUserRepo, getIdentityAuth } from "@scarn/identity";
import type { AppContext } from "@scarn/core/lib/di";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { fetchInstallationMetadata } from "@scarn/core/integrations/github-installation/infra/fetch-installation-metadata";
import { appOrigin, appRedirectUrl } from "./app-redirect";
import { safeReturnToPath } from "./install-state";

/**
 * The GitHub App install flow's edges — the session lookup, the GitHub
 * metadata fetch, and where the callback lands afterwards — split out of
 * `github-integration.ts` to keep that file under the repo's line limit.
 */

/**
 * Resolve a project's pretty settings path `/{username}/{projectSlug}/settings`
 * from its id, by looking up the project's slug and its owning personal org's
 * owner username. Falls back to the dashboard root when any part can't be
 * resolved (the legacy `/projects/:id` route no longer exists, so we never emit
 * it). Built from live username/slug so renames self-heal.
 */
export const resolveProjectSettingsPath = async (
  appContext: AppContext,
  projectId: UuidV7,
): Promise<string> => {
  const [project, org] = await Promise.all([
    appContext.projectRepo.load(projectId),
    appContext.orgRepo.findByProjectId(projectId),
  ]);
  if (!project || !org?.ownerUserId) {
    return "/";
  }

  const owner = await new DrizzleAuthUserRepo().load(org.ownerUserId);
  // No username means the owner hasn't finished onboarding, so we can't build a
  // pretty project path; fall back to the dashboard root.
  if (!owner?.username) {
    return "/";
  }

  return `/${encodeURIComponent(owner.username)}/${encodeURIComponent(project.slug)}/settings`;
};

export const redirectToProject = async (
  request: Request,
  appContext: AppContext,
  projectId: UuidV7,
  params: Record<string, string>,
): Promise<Response> => {
  const path = await resolveProjectSettingsPath(appContext, projectId);
  return Response.redirect(
    appRedirectUrl(appContext, request, path, params),
    302,
  );
};

/**
 * Redirect back to the project-creation page for the `intent: "create"`
 * install flow, which has no project yet to redirect into. `returnTo` — the
 * signed, same-origin `/projects/new?...` the install started from — keeps
 * that page's context (the CLI hand-off's prefill and `source=cli`).
 */
export const redirectToProjectsNew = (
  request: Request,
  appContext: AppContext,
  params: Record<string, string>,
  returnTo: string | undefined,
): Response => {
  const safePath = returnTo === undefined ? null : safeReturnToPath(returnTo);
  let url = appRedirectUrl(
    appContext,
    request,
    safePath ?? "/projects/new",
    params,
  );
  if (url.origin !== appOrigin(appContext, request)) {
    url = appRedirectUrl(appContext, request, "/projects/new", params);
  }
  return Response.redirect(url, 302);
};

/** The install flow's edges to the session store and to GitHub, swappable in tests. */
export type GitHubInstallFlowDeps = {
  getSessionUserId: (request: Request) => Promise<string | null>;
  fetchInstallationMetadata: typeof fetchInstallationMetadata;
};

export const defaultInstallFlowDeps: GitHubInstallFlowDeps = {
  getSessionUserId: async (request) => {
    const session = await getIdentityAuth().api.getSession({
      headers: request.headers,
    });
    return session?.user.id ?? null;
  },
  fetchInstallationMetadata,
};
