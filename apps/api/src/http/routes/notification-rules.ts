import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { listNotificationRules } from "@scarn/core/notifications/notification-policy/application/list-notification-rules";
import { upsertNotificationRule } from "@scarn/core/notifications/notification-policy/application/upsert-notification-rule";
import {
  notificationRuleSchema,
  upsertNotificationRuleSchema,
} from "@scarn/core/notifications/notification-policy/contracts/notification-rule-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { responseSchemas } from "../response-schemas";

const projectParamsSchema = z.object({
  projectId: uuidV7Schema,
});

export const createNotificationRuleRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .get(
      "/projects/:projectId/notification-rules",
      {
        params: projectParamsSchema,
        response: responseSchemas({
          200: z.array(notificationRuleSchema),
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "listNotificationRules",
          tags: ["NotificationRules"],
        },
      },
      async ({ params, auth }) => {
        const { projectId } = projectParamsSchema.parse(params);
        return await listNotificationRules(
          { projectId },
          {
            userAuthz: auth.userAuthz,
            notificationRuleRepo: appContext.notificationRuleRepo,
          },
        );
      },
    )
    .put(
      "/projects/:projectId/notification-rules",
      {
        params: projectParamsSchema,
        body: upsertNotificationRuleSchema,
        response: responseSchemas({
          200: notificationRuleSchema,
          401: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "upsertNotificationRule",
          tags: ["NotificationRules"],
        },
      },
      async ({ params, body, auth }) => {
        const { projectId } = projectParamsSchema.parse(params);
        const rule = upsertNotificationRuleSchema.parse(body);
        return await upsertNotificationRule(
          { projectId, rule },
          {
            userAuthz: auth.userAuthz,
            notificationRuleRepo: appContext.notificationRuleRepo,
          },
        );
      },
    );
