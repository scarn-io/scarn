import { Elysia } from "elysia";
import { z } from "zod";
import type { AppContext } from "@scarn/core/lib/di";
import { reconcileActiveIntegrations } from "@scarn/core/integrations/github-ingest/application/reconcile-active-integrations";
import { getGitHubAppConfig } from "@scarn/identity";
import { createServiceAuthenticated } from "./service-authenticated";
import { stdErrors } from "./task-run-route-helpers";
import { responseSchemas } from "../response-schemas";

const reconcileActiveIntegrationsResultSchema = z.object({
  integrationsAttempted: z.number().int().nonnegative(),
  integrationsSucceeded: z.number().int().nonnegative(),
  integrationsFailed: z.number().int().nonnegative(),
});

/**
 * Machine-to-machine maintenance trigger for scheduled GitHub reconciliation.
 * It is invoked on a schedule by AWS EventBridge (see
 * infra/github-reconcile-schedule.tf), authenticated with a shared bearer
 * token via `createServiceAuthenticated` against the dedicated
 * `GITHUB_RECONCILE_CRON_SECRET` (NOT `RECONCILE_CRON_SECRET`, and NOT a user
 * session) — there is no user actor for a background job, and this job mints
 * GitHub installation tokens and mutates `WorkItem`s across every active
 * integration, so its secret is isolated from the lower-stakes storage
 * reconciliation job for independent rotation/audit.
 *
 * **Drift correction, not primary sync** (Phase 4,
 * docs/plans/github-integration-sync-scaling.md, decision 14): issue-content
 * webhooks (`POST /integrations/github/webhook`) are now the real-time sync
 * path, so this cron runs at a demoted `rate(1 day)` cadence rather than every
 * 15 minutes. Its job is to catch what webhooks missed — failed deliveries,
 * webhook downtime, event types not yet handled — and to retry integrations
 * stuck in `error` status. Since GitHub does **not** auto-redeliver failed
 * webhook deliveries (decision 15), this daily sweep is the sole backstop for
 * a missed event: a webhook that never lands can now go uncorrected for up to
 * ~24h, and an `error`-status integration's self-healing worst case grows
 * from ~15min to ~24h accordingly (decision 4). Accepted given this app's
 * pre-production status — revisit before carrying real production data.
 *
 * GitHub-only scope: `reconcileActiveIntegrations` skips any non-GitHub
 * (e.g. Jira) integrations internally. The use case is idempotent-ish via the
 * underlying sync's watermark/overlap-window semantics, so a missed or
 * duplicate invocation is harmless — a failed integration simply retries on
 * the next tick.
 */
export const createIntegrationsReconcileRoutes = (appContext: AppContext) =>
  new Elysia()
    .use(createServiceAuthenticated("GITHUB_RECONCILE_CRON_SECRET"))
    .post(
      "/internal/integrations/reconcile",
      {
        response: responseSchemas({
          200: reconcileActiveIntegrationsResultSchema,
          ...stdErrors,
        }),
        detail: {
          operationId: "reconcileActiveIntegrations",
          tags: ["ProjectIntegrations"],
        },
      },
      async () => {
        const githubApp = getGitHubAppConfig();

        return await reconcileActiveIntegrations({
          projectIntegrationRepo: appContext.projectIntegrationRepo,
          projectRepo: appContext.projectRepo,
          workItemRepo: appContext.workItemRepo,
          workItemBlockRepo: appContext.workItemBlockRepo,
          workItemEvents: appContext.workItemEvents,
          githubRelationshipPendingRefRepo:
            appContext.githubRelationshipPendingRefRepo,
          secretRepo: appContext.secretRepo,
          secretCipher: appContext.secretCipher,
          timeProvider: appContext.timeProvider,
          githubApp: githubApp
            ? {
                appId: githubApp.appId,
                privateKey: githubApp.privateKey ?? "",
              }
            : { appId: "", privateKey: "" },
          logger: appContext.logger,
        });
      },
    );
