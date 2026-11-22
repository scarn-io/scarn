import { Elysia } from "elysia";
import { z } from "zod";
import { getGitHubAppConfig } from "@scarn/identity";
import type { AppContext } from "@scarn/core/lib/di";
import { CoreError } from "@scarn/core/lib/errors";
import { upsertGitHubInstallation } from "@scarn/core/integrations/github-installation/application/upsert-github-installation";
import { fetchInstallationMetadata } from "@scarn/core/integrations/github-installation/infra/fetch-installation-metadata";
import { listMyGitHubRepos } from "@scarn/core/integrations/github-installation/application/list-my-github-repos";
import { myGitHubInstallationReposSchema } from "@scarn/core/integrations/github-installation/contracts/github-installation-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { responseSchemas } from "../response-schemas";

/**
 * The "my repos" picker surface (Phase 3a of the GitHub-first project
 * creation plan): a cached listing route plus a per-installation live-refresh
 * route. Split out of `github-integration.ts` (which owns the install/
 * callback/webhook flow) purely to keep that file under the repo's 400-line
 * limit — both files together make up the GitHub integration surface and are
 * wired together via `.use()` in `createGitHubIntegrationRoutes`.
 */
export const createGitHubInstallationRepoRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .get(
      "/integrations/github/repos",
      {
        response: responseSchemas({
          200: z.array(myGitHubInstallationReposSchema),
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "listMyGitHubRepos",
          tags: ["GitHubIntegrations"],
        },
      },
      async ({ auth }) => {
        const github = getGitHubAppConfig();
        if (!github) {
          throw new CoreError({
            code: "GITHUB_APP_NOT_CONFIGURED",
            message: "GitHub App not configured",
            status: 400,
          });
        }

        return await listMyGitHubRepos(
          { userId: auth.userId },
          { githubInstallationRepo: appContext.githubInstallationRepo },
        );
      },
    )
    .post(
      "/integrations/github/installations/:installationId/refresh",
      {
        params: z.object({ installationId: z.string().min(1) }),
        response: responseSchemas({
          200: myGitHubInstallationReposSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "refreshGitHubInstallationRepos",
          tags: ["GitHubIntegrations"],
        },
      },
      async ({ params, auth }) => {
        const github = getGitHubAppConfig();
        if (!github?.privateKey) {
          throw new CoreError({
            code: "GITHUB_APP_NOT_CONFIGURED",
            message: "GitHub App not configured",
            status: 400,
          });
        }

        const installation =
          await appContext.githubInstallationRepo.findByInstallationId(
            params.installationId,
          );
        // Same 403 whether the installation doesn't exist or belongs to
        // someone else, so this endpoint never reveals which installation ids
        // are in use.
        if (!installation || installation.installedByUserId !== auth.userId) {
          throw new CoreError({
            code: "GITHUB_INSTALLATION_NOT_OWNED",
            message: "This GitHub installation does not belong to you",
            status: 403,
          });
        }

        const metadata = await fetchInstallationMetadata({
          appId: github.appId,
          privateKey: github.privateKey,
          installationId: params.installationId,
        });

        const { installation: updated } = await upsertGitHubInstallation(
          {
            installationId: params.installationId,
            accountLogin: metadata.accountLogin,
            accountType: metadata.accountType,
            targetType: metadata.targetType,
            selectedRepositories: metadata.repositories,
          },
          appContext.githubInstallationRepo,
        );

        return {
          installationId: updated.installationId,
          accountLogin: updated.accountLogin,
          repos: updated.selectedRepositories ?? [],
        };
      },
    );
