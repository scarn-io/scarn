import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { pollLentKeyIntegrations } from "@scarn/core/integrations/project-integration/application/poll-lent-key-integrations";
import { createServiceAuthenticated } from "./service-authenticated";
import { stdErrors } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

const pollLentKeyIntegrationsResultSchema = z.object({
  attempted: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  paused: z.number().int().nonnegative(),
  skippedLocked: z.number().int().nonnegative(),
  skippedRateLimited: z.number().int().nonnegative(),
});

/**
 * Machine-to-machine trigger for lent-key auto-sync
 * (docs/plans/lent-key-auto-sync.md). AWS EventBridge calls it every 5
 * minutes (see infra/integration-poll-schedule.tf), authenticated with a
 * shared bearer token via `createServiceAuthenticated` against the dedicated
 * `INTEGRATION_POLL_CRON_SECRET`, so it can be rotated and audited apart from
 * the other cron secrets.
 *
 * It syncs every Jira and GitHub token integration a project member lent a
 * saved key to, as the system actor. Each integration is claimed before it
 * syncs, so an overlapping or duplicate tick never syncs one twice.
 */
export const createIntegrationsPollRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createServiceAuthenticated("INTEGRATION_POLL_CRON_SECRET"))
    .post(
      "/internal/integrations/poll",
      {
        response: responseSchemas({
          200: pollLentKeyIntegrationsResultSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "pollLentKeyIntegrations",
          tags: ["ProjectIntegrations"],
        },
      },
      async () =>
        await pollLentKeyIntegrations({
          projectIntegrationRepo: appContext.projectIntegrationRepo,
          projectRepo: appContext.projectRepo,
          workItemRepo: appContext.workItemRepo,
          workItemBlockRepo: appContext.workItemBlockRepo,
          workItemEvents: appContext.workItemEvents,
          githubRelationshipPendingRefRepo:
            appContext.githubRelationshipPendingRefRepo,
          secretRepo: appContext.secretRepo,
          secretCipher: appContext.secretCipher,
          notifications: appContext.autoSyncPausedNotifications,
          timeProvider: appContext.timeProvider,
          logger: appContext.logger,
        }),
    );
