import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { issueWorkSignalToken } from "@scarn/core/tasks/task-run/application/issue-work-signal-token";
import {
  issueWorkSignalTokenInputSchema,
  workSignalTokenSchema,
} from "@scarn/core/tasks/task-run/contracts/work-signal-token-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { responseSchemas } from "../response-schemas";

export const createWorkSignalTokenRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .post(
      "/projects/:projectId/work-signal-token",
      {
        params: z.object({ projectId: uuidV7Schema }),
        body: issueWorkSignalTokenInputSchema.optional(),
        response: responseSchemas({
          200: workSignalTokenSchema,
          401: apiErrorResponseSchema,
          402: apiErrorResponseSchema,
          403: apiErrorResponseSchema,
          404: apiErrorResponseSchema,
          422: apiErrorResponseSchema,
          500: apiErrorResponseSchema,
        }),
        detail: {
          operationId: "issueWorkSignalToken",
          description:
            "Issues a short-lived token for subscribing to push wake-ups for the project's queued work. Each token counts as one push session against the org's monthly limit; 402 (USAGE_LIMIT_EXCEEDED_SIGNAL) once the limit is reached. 404 when push is not configured. On either, workers keep polling.",
          tags: ["TaskRuns"],
        },
      },
      async ({ params, body, auth }) =>
        await issueWorkSignalToken(params.projectId, body ?? {}, {
          userAuthz: auth.userAuthz,
          orgRepo: appContext.orgRepo,
          usageMeterRepo: appContext.usageMeterRepo,
          domainEventDispatcher: appContext.domainEventDispatcher,
          workSignalConnection: appContext.workSignalConnection,
          timeProvider: appContext.timeProvider,
        }),
    );
