import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { getGitHubAppConfig } from "@scarn/identity";
import { listPendingCommentDrafts } from "@scarn/core/notifications/user-notification/application/comment-draft/list-pending-comment-drafts";
import { approveCommentDraft } from "@scarn/core/notifications/user-notification/application/comment-draft/approve-comment-draft";
import { rejectCommentDraft } from "@scarn/core/notifications/user-notification/application/comment-draft/reject-comment-draft";
import {
  pendingCommentDraftSchema,
  userNotificationSchema,
} from "@scarn/core/notifications/user-notification/contracts/user-notification-contracts";
import { workItemCommentSchema } from "@scarn/core/work-items/work-item-comment/contracts/work-item-comment-contracts";
import { integrationCredentialChoiceSchema } from "@scarn/core/secrets/secret/contracts/secret-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { responseSchemas } from "../response-schemas";

const listQuerySchema = z.object({
  workItemId: uuidV7Schema,
});

const notificationParamsSchema = z.object({
  notificationId: uuidV7Schema,
});

const approveBodySchema = z.object({
  body: z.string().trim().min(1),
  credential: integrationCredentialChoiceSchema.optional(),
});

export const createWorkItemCommentDraftsRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .get(
      "/work-item-comment-drafts",
      {
        query: listQuerySchema,
        response: responseSchemas({
          200: z.array(pendingCommentDraftSchema),
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "listPendingCommentDrafts",
          tags: ["WorkItemCommentDrafts"],
        },
      },
      async ({ query, auth }) => {
        const { workItemId } = listQuerySchema.parse(query);
        return await listPendingCommentDrafts(
          { workItemId },
          {
            ...appContext,
            userAuthz: auth.userAuthz,
          },
        );
      },
    )
    .post(
      "/work-item-comment-drafts/:notificationId/approve",
      {
        params: notificationParamsSchema,
        body: approveBodySchema,
        response: responseSchemas({
          200: workItemCommentSchema,
          400: apiErrorResponseSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
          502: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "approveCommentDraft",
          tags: ["WorkItemCommentDrafts"],
        },
      },
      async ({ params, body, auth }) => {
        const { notificationId } = notificationParamsSchema.parse(params);
        const parsedBody = approveBodySchema.parse(body);
        const githubApp = getGitHubAppConfig();

        return await approveCommentDraft(
          {
            notificationId,
            body: parsedBody.body,
            githubApp: githubApp
              ? {
                  appId: githubApp.appId,
                  privateKey: githubApp.privateKey ?? "",
                }
              : { appId: "", privateKey: "" },
            credential: parsedBody.credential,
            appBaseUrl: appContext.appUrl,
          },
          {
            ...appContext,
            userAuthz: auth.userAuthz,
          },
        );
      },
    )
    .post(
      "/work-item-comment-drafts/:notificationId/reject",
      {
        params: notificationParamsSchema,
        response: responseSchemas({
          200: userNotificationSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          409: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "rejectCommentDraft",
          tags: ["WorkItemCommentDrafts"],
        },
      },
      async ({ params, auth }) => {
        const { notificationId } = notificationParamsSchema.parse(params);

        return await rejectCommentDraft(
          { notificationId },
          {
            ...appContext,
            userAuthz: auth.userAuthz,
          },
        );
      },
    );
