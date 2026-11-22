import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { Result } from "@scarn/core/lib/result";
import { uuidV7Schema } from "@scarn/core/common/contracts/uuid-v7";
import { getOrgUsage } from "@scarn/core/billing/usage-meter/application/get-org-usage";
import { reconcileStorageUsage } from "@scarn/core/billing/usage-meter/application/reconcile-storage-usage";
import { usageMeterSchema } from "@scarn/core/billing/usage-meter/contracts/usage-meter-contracts";
import { apiErrorResponseSchema } from "../../contracts";
import { createAuthenticated } from "./authenticated";
import { createServiceAuthenticated } from "./service-authenticated";
import { stdErrors } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

const orgIdParamsSchema = z.object({ orgId: uuidV7Schema });

const reconcileStorageResultSchema = z.object({
  orgsReconciled: z.number().int().nonnegative(),
});

// User-session-authenticated usage reads (org-scoped quota dashboard, etc.).
const createUserUsageRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createAuthenticated(appContext.createUserAuthorizationService))
    .get(
      "/orgs/:orgId/usage",
      {
        params: orgIdParamsSchema,
        response: responseSchemas({
          200: usageMeterSchema,
          404: apiErrorResponseSchema,
          ...stdErrors,
        }),
        detail: { operationId: "getOrgUsage", tags: ["Billing"] },
      },
      async ({ params, auth }) =>
        Result.unwrap(
          await getOrgUsage(orgIdParamsSchema.parse(params).orgId, {
            userAuthz: auth.userAuthz,
            orgRepo: appContext.orgRepo,
            usageMeterRepo: appContext.usageMeterRepo,
            storageUsageReader: appContext.storageUsageReader,
            timeProvider: appContext.timeProvider,
          }),
        ),
    );

// Machine-to-machine maintenance trigger for storage reconciliation. The S3
// lifecycle rule deletes expired archive objects without notifying the app, so
// this recomputes each org's retained-byte meter. It is invoked on a schedule
// by AWS EventBridge (see infra/reconcile-schedule.tf), authenticated with a
// shared bearer token via `createServiceAuthenticated` (NOT a user session) —
// there is no user actor for a background job. The use case is idempotent, so a
// missed or duplicate invocation is harmless.
const createReconcileStorageRoute = (appContext: AppContext) =>
  new Elysia().use(createServiceAuthenticated()).post(
    "/internal/usage/reconcile-storage",
    {
      response: responseSchemas({
        200: reconcileStorageResultSchema,
        ...stdErrors,
      }),
      detail: {
        operationId: "reconcileStorageUsage",
        tags: ["Billing"],
      },
    },
    async () =>
      await reconcileStorageUsage({
        usageMeterRepo: appContext.usageMeterRepo,
        storageUsageReader: appContext.storageUsageReader,
        taskRunRepo: appContext.taskRunRepo,
        artifactRepo: appContext.artifactRepo,
        artifactFailureRepo: appContext.artifactFailureRepo,
        timeProvider: appContext.timeProvider,
        logger: appContext.logger,
      }),
  );

export const createUsageRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createUserUsageRoutes(appContext))
    .use(createReconcileStorageRoute(appContext));
