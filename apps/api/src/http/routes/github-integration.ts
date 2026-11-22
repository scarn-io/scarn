import { Elysia } from "elysia";
import { AnalyticsEvents } from "@scarn/observability/analytics/events";
import { getGitHubAppConfig, getGitHubAppWebhookSecret } from "@scarn/identity";
import type { AppContext } from "@scarn/core/lib/di";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createProjectIntegration } from "@scarn/core/integrations/project-integration/application/create-project-integration";
import { upsertGitHubInstallation } from "@scarn/core/integrations/github-installation/application/upsert-github-installation";
import { handleInstallationDeleted } from "@scarn/core/integrations/github-installation/application/handle-installation-deleted";
import { handleInstallationRepositoriesRemoved } from "@scarn/core/integrations/github-installation/application/handle-installation-repositories-removed";
import { resolveProjectIntegrationForRepo } from "@scarn/core/integrations/github-installation/application/resolve-project-integration-for-repo";
import { upsertWorkItemFromGitHubIssueWebhook } from "@scarn/core/integrations/github-ingest/application/upsert-work-item-from-github-issue-webhook";
import { SystemAuthorizationService } from "@scarn/core/access/authorization/infra/system-authorization-service";
import type { GitHubIssue } from "@scarn/core/integrations/github-ingest/infra/github-issues-client";
import {
  defaultInstallFlowDeps,
  redirectToProject,
  redirectToProjectsNew,
  type GitHubInstallFlowDeps,
} from "./github-install-flow";
import { appRedirectUrl } from "./app-redirect";
import { createGitHubInstallationRepoRoutes } from "./github-installation-repos";
import {
  InstallStateError,
  safeReturnToPath,
  signInstallState,
  verifyInstallState,
} from "./install-state";
import {
  verifyWebhookSignature,
  WebhookSignatureError,
} from "./verify-webhook-signature";

type InstallationPayload = {
  action?: string;
  installation?: { id?: number };
  repositories_removed?: { id?: number }[];
  repository?: { id?: number; full_name?: string };
  issue?: GitHubIssue;
};

const extractInstallationId = (payload: InstallationPayload): string | null => {
  const id = payload.installation?.id;
  return typeof id === "number" ? String(id) : null;
};

const extractRemovedRepoIds = (payload: InstallationPayload): number[] => {
  const list = payload.repositories_removed ?? [];
  return list
    .map((entry) => entry.id)
    .filter((id): id is number => typeof id === "number");
};

/**
 * `issues` webhook actions this dispatcher handles (decisions 5, 11, 12, 13,
 * docs/plans/github-integration-sync-scaling.md Phase 4). `issue_comment` is
 * explicitly out of scope — see the plan's "Out of scope" section.
 */
const GITHUB_ISSUE_WEBHOOK_ACTIONS = new Set([
  "opened",
  "edited",
  "closed",
  "reopened",
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
]);

export const createGitHubIntegrationRoutes = (
  appContext: AppContext,
  deps: GitHubInstallFlowDeps = defaultInstallFlowDeps,
) =>
  new Elysia()
    .get(
      "/integrations/github/install",
      {
        detail: {
          operationId: "beginGitHubAppInstall",
          tags: ["GitHubIntegrations"],
        },
      },
      async ({ request }) => {
        const sessionUserId = await deps.getSessionUserId(request);
        if (!sessionUserId) {
          return Response.redirect(
            appRedirectUrl(appContext, request, "/login"),
            302,
          );
        }

        const url = new URL(request.url);
        const projectIdParam = url.searchParams.get("projectId");
        const returnToParam = url.searchParams.get("returnTo");
        const returnTo =
          returnToParam === null
            ? undefined
            : (safeReturnToPath(returnToParam) ?? undefined);

        let projectId: UuidV7 | undefined;
        if (projectIdParam) {
          try {
            projectId = parseUuidV7(projectIdParam);
          } catch {
            return Response.json(
              { error: "projectId invalid" },
              { status: 400 },
            );
          }
        }

        const github = getGitHubAppConfig();
        if (!github) {
          return Response.json(
            { error: "GitHub App not configured" },
            { status: 400 },
          );
        }

        const state = projectId
          ? signInstallState({ intent: "link", projectId })
          : signInstallState({ intent: "create", returnTo });
        const installUrl = `https://github.com/apps/${github.appSlug}/installations/new?state=${encodeURIComponent(state)}`;
        return Response.redirect(installUrl, 302);
      },
    )
    .get(
      "/integrations/github/callback",
      {
        detail: {
          operationId: "completeGitHubAppInstall",
          tags: ["GitHubIntegrations"],
        },
      },
      async ({ request }) => {
        const sessionUserId = await deps.getSessionUserId(request);
        if (!sessionUserId) {
          return Response.redirect(
            appRedirectUrl(appContext, request, "/login"),
            302,
          );
        }

        const url = new URL(request.url);
        const installationId = url.searchParams.get("installation_id");
        const state = url.searchParams.get("state");
        if (!installationId || !state) {
          return Response.redirect(
            appRedirectUrl(appContext, request, "/", {
              error: "missing_params",
            }),
            302,
          );
        }

        let claims;
        try {
          claims = verifyInstallState(state);
        } catch (error) {
          const reason =
            error instanceof InstallStateError ? error.reason : "invalid_state";
          return Response.redirect(
            appRedirectUrl(appContext, request, "/", { error: reason }),
            302,
          );
        }

        const userId = parseUuidV7(sessionUserId);

        if (claims.intent === "create") {
          const github = getGitHubAppConfig();
          if (!github?.privateKey) {
            return redirectToProjectsNew(
              request,
              appContext,
              { error: "github_app_not_configured" },
              claims.returnTo,
            );
          }

          const metadata = await deps.fetchInstallationMetadata({
            appId: github.appId,
            privateKey: github.privateKey,
            installationId,
          });

          // No project exists yet on this path — just attribute the
          // installation to the installing user (even when it has zero
          // repositories, so it still appears grouped under its account in
          // the repo picker) and send them back to finish creating a project.
          const { created } = await upsertGitHubInstallation(
            {
              installationId,
              accountLogin: metadata.accountLogin,
              accountType: metadata.accountType,
              targetType: metadata.targetType,
              selectedRepositories: metadata.repositories,
              installedByUserId: userId,
            },
            appContext.githubInstallationRepo,
          );
          appContext.analytics.capture(
            userId,
            AnalyticsEvents.GithubAppInstalled,
            { intent: "create", new_installation: created },
          );

          return redirectToProjectsNew(
            request,
            appContext,
            { installation: "connected" },
            claims.returnTo,
          );
        }

        const projectId = parseUuidV7(claims.projectId);
        const userAuthz = appContext.createUserAuthorizationService(userId);
        await userAuthz.requireProjectPermission({
          projectId,
          permission: "integrations:write",
        });

        const github = getGitHubAppConfig();
        if (!github?.privateKey) {
          return await redirectToProject(request, appContext, projectId, {
            error: "github_app_not_configured",
          });
        }

        const metadata = await deps.fetchInstallationMetadata({
          appId: github.appId,
          privateKey: github.privateKey,
          installationId,
        });

        const { created } = await upsertGitHubInstallation(
          {
            installationId,
            accountLogin: metadata.accountLogin,
            accountType: metadata.accountType,
            targetType: metadata.targetType,
            selectedRepositories: metadata.repositories,
          },
          appContext.githubInstallationRepo,
        );
        appContext.analytics.capture(
          userId,
          AnalyticsEvents.GithubAppInstalled,
          {
            intent: "link",
            new_installation: created,
          },
        );

        if (metadata.repositories.length === 0) {
          return await redirectToProject(request, appContext, projectId, {
            integration: "no_repositories",
          });
        }

        try {
          await createProjectIntegration(
            {
              projectId,
              kind: "github_app",
              installationId,
              externalScope: { repos: metadata.repositories },
            },
            appContext.projectIntegrationRepo,
          );
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error
              ? error.code
              : null;
          if (code !== "PROJECT_INTEGRATION_DUPLICATE") {
            throw error;
          }
        }

        return await redirectToProject(request, appContext, projectId, {
          integration: "connected",
        });
      },
    )
    .post(
      "/integrations/github/webhook",
      {
        // The handler reads the raw body itself (`request.text()`) to verify
        // the HMAC signature against the exact bytes GitHub signed —
        // `parse: "none"` stops Elysia from eagerly consuming the body via
        // its own content-type-based parser first, which otherwise throws
        // `ERR_BODY_ALREADY_USED` on this handler's `request.text()` call
        // once any `.onError` hook is registered on the app (as the real
        // app always does — this was a latent, unexercised bug for every
        // webhook event, not something new to Phase 4).
        parse: "none",
        detail: {
          operationId: "handleGitHubWebhook",
          tags: ["GitHubIntegrations"],
        },
      },
      /**
       * Real-time sync path for GitHub issue content (Phase 4,
       * docs/plans/github-integration-sync-scaling.md): `issues.opened` /
       * `edited` / `closed` / `reopened` / `labeled` / `unlabeled` /
       * `assigned` / `unassigned` upsert a work item directly from the
       * payload (decision 5 — no follow-up GitHub API call), on top of the
       * pre-existing `installation.deleted` /
       * `installation_repositories.removed` handling. `issue_comment` is out
       * of scope. No feature flag gates this dispatcher (decision 13) — the
       * daily reconcile sweep (`/internal/integrations/reconcile`) is now
       * the sole backstop for any event this handler misses or that GitHub
       * fails to deliver (decision 15), since GitHub never auto-redelivers a
       * failed webhook delivery.
       */
      async ({ request }) => {
        const secret = getGitHubAppWebhookSecret();
        if (!secret) {
          return Response.json(
            { error: "Webhook secret not configured" },
            { status: 503 },
          );
        }

        const rawBody = await request.text();
        try {
          verifyWebhookSignature({
            rawBody,
            signatureHeader: request.headers.get("x-hub-signature-256"),
            secret,
          });
        } catch (error) {
          const reason =
            error instanceof WebhookSignatureError ? error.reason : "invalid";
          return Response.json({ error: reason }, { status: 401 });
        }

        const event = request.headers.get("x-github-event");
        let payload: InstallationPayload;
        try {
          payload = JSON.parse(rawBody) as InstallationPayload;
        } catch {
          return Response.json({ error: "invalid_json" }, { status: 400 });
        }

        if (event === "installation" && payload.action === "deleted") {
          const installationId = extractInstallationId(payload);
          if (!installationId) {
            return { ok: true, ignored: "no_installation_id" };
          }
          const result = await handleInstallationDeleted(installationId, {
            githubInstallationRepo: appContext.githubInstallationRepo,
            projectIntegrationRepo: appContext.projectIntegrationRepo,
          });
          return { ok: true, ...result };
        }

        if (
          event === "installation_repositories" &&
          payload.action === "removed"
        ) {
          const installationId = extractInstallationId(payload);
          const removedRepositoryIds = extractRemovedRepoIds(payload);
          if (!installationId || removedRepositoryIds.length === 0) {
            return { ok: true, ignored: "no_targets" };
          }
          const result = await handleInstallationRepositoriesRemoved(
            { installationId, removedRepositoryIds },
            {
              githubInstallationRepo: appContext.githubInstallationRepo,
              projectIntegrationRepo: appContext.projectIntegrationRepo,
            },
          );
          return { ok: true, ...result };
        }

        if (
          event === "issues" &&
          payload.action &&
          GITHUB_ISSUE_WEBHOOK_ACTIONS.has(payload.action)
        ) {
          const installationId = extractInstallationId(payload);
          const repositoryId = payload.repository?.id;
          const issue = payload.issue;
          if (!installationId || typeof repositoryId !== "number" || !issue) {
            return { ok: true, ignored: "issues_missing_fields" };
          }

          const integration = await resolveProjectIntegrationForRepo(
            { installationId, repositoryId },
            { projectIntegrationRepo: appContext.projectIntegrationRepo },
          );
          if (!integration) {
            return { ok: true, ignored: "no_matching_project_integration" };
          }

          const repoFullName =
            integration.scope.repos.find((repo) => repo.id === repositoryId)
              ?.fullName ??
            payload.repository?.full_name ??
            "";

          const result = await upsertWorkItemFromGitHubIssueWebhook(
            { projectId: integration.projectId, repoFullName, issue },
            {
              userAuthz: new SystemAuthorizationService(appContext.projectRepo),
              workItemRepo: appContext.workItemRepo,
              workItemBlockRepo: appContext.workItemBlockRepo,
              workItemEvents: appContext.workItemEvents,
              timeProvider: appContext.timeProvider,
            },
          );
          return { ok: true, applied: result.applied };
        }

        return { ok: true, ignored: event ?? "unknown" };
      },
    )
    .use(createGitHubInstallationRepoRoutes(appContext));
