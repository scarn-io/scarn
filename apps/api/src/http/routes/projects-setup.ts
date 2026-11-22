import { Elysia } from "elysia";
import { getGitHubAppConfig } from "@scarn/identity";
import type { AppContext } from "@scarn/core/lib/di";
import type { UserAuthorizationService } from "@scarn/core/access/authorization/application/user-authorization-service";
import { createProject } from "@scarn/core/projects/project/application/create-project";
import { setUpProject } from "@scarn/core/projects/project/application/set-up-project";
import { checkProjectRepo } from "@scarn/core/projects/project/application/check-project-repo";
import { checkProjectIssueTracker } from "@scarn/core/projects/project/application/check-project-issue-tracker";
import {
  issueTrackerCheckInputSchema,
  issueTrackerCheckResponseSchema,
  repoCheckInputSchema,
  repoCheckResponseSchema,
  setUpProjectInputSchema,
  setUpProjectResponseSchema,
} from "@scarn/core/projects/project/contracts/project-setup-contracts";
import { runProjectIntegrationSync } from "@scarn/core/integrations/github-ingest/application/run-project-integration-sync";
import { installationRepoResolver } from "@scarn/core/integrations/github-installation/infra/fetch-installation-repo";
import { upsertWorkItems } from "@scarn/core/work-items/work-item/application/upsert-work-item";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { responseSchemas } from "../response-schemas";

const githubAppCredentials = () => {
  const githubApp = getGitHubAppConfig();
  return githubApp
    ? { appId: githubApp.appId, privateKey: githubApp.privateKey ?? "" }
    : { appId: "", privateKey: "" };
};

const credentialDeps = (
  appContext: AppContext,
  userAuthz: UserAuthorizationService,
) => ({
  userAuthz,
  secretRepo: appContext.secretRepo,
  secretCipher: appContext.secretCipher,
  timeProvider: appContext.timeProvider,
  githubInstallationRepo: appContext.githubInstallationRepo,
  resolveInstallationRepo: installationRepoResolver(getGitHubAppConfig()),
});

const errorResponses = {
  400: apiErrorResponseSchema,
  401: apiErrorResponseSchema,
  403: apiErrorResponseSchema,
  404: apiErrorResponseSchema,
  422: apiErrorResponseSchema,
  500: apiErrorResponseSchema,
  502: apiErrorResponseSchema,
};

/**
 * Creating a project and connecting its issue tracker: the repo and
 * credential checks the new-project wizard runs first, then `POST /projects`
 * itself. None of these routes ever save a secret.
 */
export const createProjectSetupRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/projects/repo-check",
      {
        body: repoCheckInputSchema,
        response: responseSchemas({
          200: repoCheckResponseSchema,
          401: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: { operationId: "checkProjectRepo", tags: ["Projects"] },
      },
      async ({ body, auth }) =>
        await checkProjectRepo(
          { ...body, userId: auth.userId },
          {
            projectRepo: appContext.projectRepo,
            githubInstallationRepo: appContext.githubInstallationRepo,
            orgRepo: appContext.orgRepo,
            usernameReader: appContext.usernameReader,
            githubAppConfigured: getGitHubAppConfig() !== null,
            resolveInstallationRepo:
              installationRepoResolver(getGitHubAppConfig()),
          },
        ),
    )
    .post(
      "/projects/issue-tracker-check",
      {
        body: issueTrackerCheckInputSchema,
        response: responseSchemas({
          200: issueTrackerCheckResponseSchema,
          ...errorResponses,
        }),
        detail: {
          operationId: "checkProjectIssueTracker",
          tags: ["Projects"],
        },
      },
      async ({ body, auth }) =>
        await checkProjectIssueTracker(
          { ...body, userId: auth.userId },
          credentialDeps(appContext, auth.userAuthz),
        ),
    )
    .post(
      "/projects",
      {
        body: setUpProjectInputSchema,
        response: responseSchemas({
          200: setUpProjectResponseSchema,
          ...errorResponses,
        }),
        detail: { operationId: "createProject", tags: ["Projects"] },
      },
      async ({ body, auth }) =>
        await setUpProject(
          { ...body, userId: auth.userId },
          {
            ...credentialDeps(appContext, auth.userAuthz),
            projectIntegrationRepo: appContext.projectIntegrationRepo,
            logger: appContext.logger,
            createProject: (input) =>
              createProject(input, {
                userAuthz: auth.userAuthz,
                projectRepo: appContext.projectRepo,
                orgRepo: appContext.orgRepo,
                timeProvider: appContext.timeProvider,
                domainEventDispatcher: appContext.domainEventDispatcher,
                analytics: appContext.analytics,
              }),
            runInitialSync: ({ projectId, integrationId, credential }) =>
              runProjectIntegrationSync(
                {
                  projectId,
                  integrationId,
                  githubApp: githubAppCredentials(),
                  credential,
                  cause: "manual",
                },
                {
                  userAuthz: auth.userAuthz,
                  projectIntegrationRepo: appContext.projectIntegrationRepo,
                  workItemRepo: appContext.workItemRepo,
                  workItemBlockRepo: appContext.workItemBlockRepo,
                  workItemEvents: appContext.workItemEvents,
                  githubRelationshipPendingRefRepo:
                    appContext.githubRelationshipPendingRefRepo,
                  upsertWorkItems: (items, workItemEvents) =>
                    upsertWorkItems(items, {
                      ...appContext,
                      userAuthz: auth.userAuthz,
                      workItemEvents,
                    }),
                  secretRepo: appContext.secretRepo,
                  secretCipher: appContext.secretCipher,
                  timeProvider: appContext.timeProvider,
                  logger: appContext.logger,
                },
              ),
          },
        ),
    );
