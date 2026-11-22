import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { listUserNotifications } from "@scarn/core/notifications/user-notification/application/list-user-notifications";
import { getUserNotification } from "@scarn/core/notifications/user-notification/application/get-user-notification";
import { dismissUserNotification } from "@scarn/core/notifications/user-notification/application/dismiss-user-notification";
import { respondToFeedbackRequest } from "@scarn/core/notifications/user-notification/application/respond-to-feedback-request";
import {
  userNotificationSchema,
  userNotificationStatusSchema,
  userNotificationWithDeliveriesSchema,
} from "@scarn/core/notifications/user-notification/contracts/user-notification-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { responseSchemas } from "../response-schemas";

const projectParamsSchema = z.object({
  projectId: uuidV7Schema,
});

const notificationParamsSchema = z.object({
  projectId: uuidV7Schema,
  notificationId: uuidV7Schema,
});

const listQuerySchema = z.object({
  workItemId: uuidV7Schema.optional(),
  status: userNotificationStatusSchema.optional(),
});

const respondBodySchema = z.object({
  answer: z.string().min(1),
});

export const createUserNotificationRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .get(
      "/projects/:projectId/notifications",
      {
        params: projectParamsSchema,
        query: listQuerySchema,
        response: responseSchemas({
          200: z.array(userNotificationSchema),
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "listUserNotifications",
          tags: ["UserNotifications"],
        },
      },
      async ({ params, query, auth }) => {
        const { projectId } = projectParamsSchema.parse(params);
        const { workItemId, status } = listQuerySchema.parse(query);
        return await listUserNotifications(
          { projectId, workItemId, status },
          {
            userAuthz: auth.userAuthz,
            userNotificationRepo: appContext.userNotificationRepo,
          },
        );
      },
    )
    .get(
      "/projects/:projectId/notifications/:notificationId",
      {
        params: notificationParamsSchema,
        response: responseSchemas({
          200: userNotificationWithDeliveriesSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "getUserNotification",
          tags: ["UserNotifications"],
        },
      },
      async ({ params, auth }) =>
        await getUserNotification(notificationParamsSchema.parse(params), {
          userAuthz: auth.userAuthz,
          userNotificationRepo: appContext.userNotificationRepo,
          notificationDeliveryRepo: appContext.notificationDeliveryRepo,
        }),
    )
    .post(
      "/projects/:projectId/notifications/:notificationId/dismiss",
      {
        params: notificationParamsSchema,
        response: responseSchemas({
          200: z.null(),
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "dismissUserNotification",
          tags: ["UserNotifications"],
        },
      },
      async ({ params, auth }) =>
        await dismissUserNotification(notificationParamsSchema.parse(params), {
          userAuthz: auth.userAuthz,
          userNotificationRepo: appContext.userNotificationRepo,
        }),
    )
    .post(
      "/projects/:projectId/notifications/:notificationId/respond",
      {
        params: notificationParamsSchema,
        body: respondBodySchema,
        response: responseSchemas({
          200: userNotificationSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "respondToFeedbackRequest",
          tags: ["UserNotifications"],
        },
      },
      async ({ params, body, auth }) => {
        const { projectId, notificationId } =
          notificationParamsSchema.parse(params);
        const { answer } = respondBodySchema.parse(body);
        return await respondToFeedbackRequest(
          { projectId, notificationId, answer },
          {
            userAuthz: auth.userAuthz,
            userNotificationRepo: appContext.userNotificationRepo,
          },
        );
      },
    );
