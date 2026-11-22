import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { CoreError } from "@scarn/core/lib/errors";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { createProjectInvite } from "@scarn/core/projects/project-invite/application/create-project-invite";
import { listProjectInvites } from "@scarn/core/projects/project-invite/application/list-project-invites";
import { getProjectInviteByToken } from "@scarn/core/projects/project-invite/application/get-project-invite-by-token";
import { acceptProjectInvite } from "@scarn/core/projects/project-invite/application/accept-project-invite";
import { revokeProjectInvite } from "@scarn/core/projects/project-invite/application/revoke-project-invite";
import { projectInviteEntityToContract } from "@scarn/core/projects/project-invite/application/project-invite-contract-mapper";
import {
  createProjectInviteInputSchema,
  projectInviteSchema,
  publicInviteDetailsSchema,
} from "@scarn/core/projects/project-invite/contracts/project-invite-contracts";
import { DrizzleAuthUserRepo } from "@scarn/identity";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { responseSchemas } from "../response-schemas";

const projectInviteListParamsSchema = z.object({
  projectId: uuidV7Schema,
});

const projectInviteItemParamsSchema = z.object({
  projectId: uuidV7Schema,
  inviteId: uuidV7Schema,
});

const tokenParamsSchema = z.object({
  token: z.string(),
});

const createProjectInviteResponseSchema = z.object({
  invite: projectInviteSchema,
  inviteUrl: z.string(),
});

export const createProjectInviteRoutes = (appContext: AppContext) =>
  new Elysia()
    // GET /project-invites/:token — public token lookup (no auth)
    .get(
      "/project-invites/:token",
      {
        params: tokenParamsSchema,
        response: responseSchemas({
          200: publicInviteDetailsSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "getProjectInviteByToken",
          tags: ["ProjectInvites"],
        },
      },
      async ({ params }) => {
        const { token } = tokenParamsSchema.parse(params);

        const result = await getProjectInviteByToken(
          { rawToken: token },
          {
            projectInviteRepo: appContext.projectInviteRepo,
            projectRepo: appContext.projectRepo,
            orgRepo: appContext.orgRepo,
            usernameReader: appContext.usernameReader,
          },
        );

        if (!result.ok) {
          const { code, message } = result.error;
          throw new CoreError({ code, message, status: 404 });
        }

        const details = result.value;
        return {
          inviteId: details.inviteId,
          projectId: details.projectId,
          projectName: details.projectName,
          projectSlug: details.projectSlug,
          ownerUsername: details.ownerUsername,
          role: details.role,
          restriction: details.restriction,
          permissions: details.permissions,
          status: details.status,
          expiresAt: details.expiresAt.toISOString(),
        };
      },
    )
    .use(
      new Elysia()
        .use(createAuthenticated(appContext.createUserAuthorizationService))
        // POST /projects/:projectId/invites — create an invite (authenticated)
        .post(
          "/projects/:projectId/invites",
          {
            params: projectInviteListParamsSchema,
            body: createProjectInviteInputSchema,
            response: responseSchemas({
              200: createProjectInviteResponseSchema,
              400: apiErrorResponseSchema,
              401: apiErrorResponseSchema,
              403: apiErrorResponseSchema,
              409: apiErrorResponseSchema,
              422: apiErrorResponseSchema,
              500: apiErrorResponseSchema,
            }),
            detail: {
              operationId: "createProjectInvite",
              tags: ["ProjectInvites"],
            },
          },
          async ({ params, body, auth }) => {
            const { projectId } = projectInviteListParamsSchema.parse(params);
            const authUserRepo = new DrizzleAuthUserRepo();

            const result = await createProjectInvite(
              {
                projectId,
                email: body.email,
                role: body.role,
                restriction: body.restriction,
                invitedByUserId: auth.userId,
              },
              {
                projectRepo: appContext.projectRepo,
                projectInviteRepo: appContext.projectInviteRepo,
                authUserRepo,
              },
            );

            if (!result.ok) {
              const { code, message } = result.error;
              if (code === "UNAUTHORIZED") {
                throw new CoreError({ code, message, status: 403 });
              }
              if (code === "INVITE_ALREADY_MEMBER") {
                throw new CoreError({
                  code,
                  message: "This user is already in this project",
                  status: 409,
                });
              }
              throw new CoreError({ code, message, status: 400 });
            }

            const { invite, rawToken } = result.value;
            const appUrl = appContext.appUrl;
            if (!appUrl) {
              throw new CoreError({
                code: "MISSING_CONFIG",
                message: "APP_URL environment variable is not set",
                status: 500,
              });
            }
            const inviteUrl = `${appUrl}/invite/${rawToken}`;

            return {
              invite: projectInviteEntityToContract(invite),
              inviteUrl,
            };
          },
        )
        // GET /projects/:projectId/invites — list pending invites (authenticated)
        .get(
          "/projects/:projectId/invites",
          {
            params: projectInviteListParamsSchema,
            response: responseSchemas({
              200: z.array(projectInviteSchema),
              401: apiErrorResponseSchema,
              403: apiErrorResponseSchema,
              422: apiErrorResponseSchema,
              500: apiErrorResponseSchema,
            }),
            detail: {
              operationId: "listProjectInvites",
              tags: ["ProjectInvites"],
            },
          },
          async ({ params, auth }) => {
            const { projectId } = projectInviteListParamsSchema.parse(params);

            const result = await listProjectInvites(
              { projectId, actorId: auth.userId },
              {
                projectRepo: appContext.projectRepo,
                projectInviteRepo: appContext.projectInviteRepo,
              },
            );

            if (!result.ok) {
              const { code, message } = result.error;
              throw new CoreError({ code, message, status: 403 });
            }

            return result.value.map(projectInviteEntityToContract);
          },
        )
        // POST /projects/:projectId/invites/:inviteId/revoke — revoke an invite (authenticated)
        .post(
          "/projects/:projectId/invites/:inviteId/revoke",
          {
            params: projectInviteItemParamsSchema,
            response: responseSchemas({
              200: projectInviteSchema,
              401: apiErrorResponseSchema,
              403: apiErrorResponseSchema,
              404: apiErrorResponseSchema,
              422: apiErrorResponseSchema,
              500: apiErrorResponseSchema,
            }),
            detail: {
              operationId: "revokeProjectInvite",
              tags: ["ProjectInvites"],
            },
          },
          async ({ params, auth }) => {
            const { projectId, inviteId } =
              projectInviteItemParamsSchema.parse(params);

            const result = await revokeProjectInvite(
              { inviteId, actorId: auth.userId, projectId },
              {
                projectRepo: appContext.projectRepo,
                projectInviteRepo: appContext.projectInviteRepo,
              },
            );

            if (!result.ok) {
              const { code, message } = result.error;
              if (code === "INVITE_NOT_FOUND") {
                throw new CoreError({ code, message, status: 404 });
              }
              throw new CoreError({ code, message, status: 403 });
            }

            return projectInviteEntityToContract(result.value);
          },
        )
        // POST /project-invites/:token/accept — accept an invite (authenticated)
        .post(
          "/project-invites/:token/accept",
          {
            params: tokenParamsSchema,
            response: responseSchemas({
              200: projectInviteSchema,
              401: apiErrorResponseSchema,
              403: apiErrorResponseSchema,
              404: apiErrorResponseSchema,
              409: apiErrorResponseSchema,
              410: apiErrorResponseSchema,
              422: apiErrorResponseSchema,
              500: apiErrorResponseSchema,
            }),
            detail: {
              operationId: "acceptProjectInvite",
              tags: ["ProjectInvites"],
            },
          },
          async ({ params, auth }) => {
            const { token } = tokenParamsSchema.parse(params);
            const actorEmail = auth.user.email;

            const result = await acceptProjectInvite(
              {
                rawToken: token,
                actorId: auth.userId,
                actorEmail,
              },
              {
                projectInviteRepo: appContext.projectInviteRepo,
                projectRepo: appContext.projectRepo,
                analytics: appContext.analytics,
                timeProvider: appContext.timeProvider,
                managedConnectionRepo: appContext.managedConnectionRepo,
                managedOAuthAttemptRepo: appContext.managedOAuthAttemptRepo,
                managedOAuthGrantRepo: appContext.managedOAuthGrantRepo,
                managedConnectionEventRepo:
                  appContext.managedConnectionEventRepo,
              },
            );

            if (!result.ok) {
              const { code, message } = result.error;
              if (code === "INVITE_NOT_FOUND") {
                throw new CoreError({ code, message, status: 404 });
              }
              if (code === "INVITE_EMAIL_MISMATCH") {
                throw new CoreError({ code, message, status: 403 });
              }
              if (code === "INVITE_EXPIRED") {
                throw new CoreError({ code, message, status: 410 });
              }
              throw new CoreError({ code, message, status: 409 });
            }

            return projectInviteEntityToContract(result.value);
          },
        ),
    );
