import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { CoreValidationError } from "@scarn/core/lib/errors";
import { createProjectIntegration } from "@scarn/core/integrations/project-integration/application/create-project-integration";
import { listProjectIntegrations } from "@scarn/core/integrations/project-integration/application/list-project-integrations";
import { deleteProjectIntegration } from "@scarn/core/integrations/project-integration/application/delete-project-integration";
import { projectIntegrationEntityToContract } from "@scarn/core/integrations/project-integration/application/project-integration-contract-mapper";
import {
  createProjectIntegrationInputSchema,
  projectIntegrationSchema,
} from "@scarn/core/integrations/project-integration/contracts/project-integration-contracts";
import { runProjectIntegrationSync } from "@scarn/core/integrations/github-ingest/application/run-project-integration-sync";
import { upsertWorkItems } from "@scarn/core/work-items/work-item/application/upsert-work-item";
import { integrationCredentialChoiceSchema } from "@scarn/core/secrets/secret/contracts/secret-contracts";
import { getGitHubAppConfig } from "@scarn/identity";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { responseSchemas } from "../response-schemas";

const projectIntegrationListParamsSchema = z.object({
  projectId: uuidV7Schema,
});

const projectIntegrationItemParamsSchema = z.object({
  projectId: uuidV7Schema,
  integrationId: uuidV7Schema,
});

export const createProjectIntegrationRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .get(
      "/projects/:projectId/integrations",
      {
        params: projectIntegrationListParamsSchema,
        response: responseSchemas({
          200: z.array(projectIntegrationSchema),
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "listProjectIntegrations",
          tags: ["ProjectIntegrations"],
        },
      },
      async ({ params, auth }) => {
        const { projectId } = projectIntegrationListParamsSchema.parse(params);
        await auth.userAuthz.requireProjectPermission({
          projectId,
          permission: "work-items:read",
        });

        const integrations = await listProjectIntegrations(
          projectId,
          appContext.projectIntegrationRepo,
        );
        const now = appContext.timeProvider.now();
        return integrations.map((integration) =>
          projectIntegrationEntityToContract(integration, now),
        );
      },
    )
    .post(
      "/projects/:projectId/integrations",
      {
        params: projectIntegrationListParamsSchema,
        body: z.any(),
        response: responseSchemas({
          200: projectIntegrationSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "createProjectIntegration",
          tags: ["ProjectIntegrations"],
        },
      },
      async ({ params, body, auth }) => {
        const { projectId } = projectIntegrationListParamsSchema.parse(params);
        await auth.userAuthz.requireProjectPermission({
          projectId,
          permission: "integrations:write",
        });

        const parsed = createProjectIntegrationInputSchema.safeParse(body);
        if (!parsed.success) {
          throw new CoreValidationError(
            "Invalid project integration input",
            "PROJECT_INTEGRATION_INPUT_INVALID",
          );
        }

        const created = await createProjectIntegration(
          { ...parsed.data, projectId },
          appContext.projectIntegrationRepo,
        );

        return projectIntegrationEntityToContract(
          created,
          appContext.timeProvider.now(),
        );
      },
    )
    .post(
      "/projects/:projectId/integrations/:integrationId/sync",
      {
        params: projectIntegrationItemParamsSchema,
        body: integrationCredentialChoiceSchema.optional(),
        response: responseSchemas({
          200: z.object({
            totalUpserted: z.number().int(),
            perSource: z.array(
              z.object({
                key: z.string(),
                totalSeen: z.number().int(),
                totalUpserted: z.number().int(),
              }),
            ),
            // GitHub-only relationship-ingestion counts; absent on the Jira
            // branch's return.
            parentLinksApplied: z.number().int().optional(),
            parentLinksSkipped: z.number().int().optional(),
            blocksCreated: z.number().int().optional(),
            blocksSkipped: z.number().int().optional(),
          }),
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          502: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "syncProjectIntegration",
          tags: ["ProjectIntegrations"],
        },
      },
      async ({ params, body, auth }) => {
        const { projectId, integrationId } =
          projectIntegrationItemParamsSchema.parse(params);

        const githubApp = getGitHubAppConfig();

        const result = await runProjectIntegrationSync(
          {
            projectId,
            integrationId,
            githubApp: githubApp
              ? {
                  appId: githubApp.appId,
                  privateKey: githubApp.privateKey ?? "",
                }
              : { appId: "", privateKey: "" },
            credential: body,
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
        );

        return result;
      },
    )
    .delete(
      "/projects/:projectId/integrations/:integrationId",
      {
        params: projectIntegrationItemParamsSchema,
        response: responseSchemas({
          200: z.null(),
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "deleteProjectIntegration",
          tags: ["ProjectIntegrations"],
        },
      },
      async ({ params, auth }) => {
        const { projectId, integrationId } =
          projectIntegrationItemParamsSchema.parse(params);
        await auth.userAuthz.requireProjectPermission({
          projectId,
          permission: "integrations:write",
        });

        await deleteProjectIntegration(
          integrationId,
          projectId,
          appContext.projectIntegrationRepo,
        );

        return Response.json(null);
      },
    );
