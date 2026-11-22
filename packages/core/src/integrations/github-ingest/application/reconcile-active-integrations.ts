import { SystemAuthorizationService } from "@scarn/core/access/authorization/infra/system-authorization-service";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import type { WorkItemBlockRepo } from "@scarn/core/work-items/work-item-block/application/work-item-block-repo";
import type { WorkItemEventsPort } from "@scarn/core/work-items/work-item/application/work-item-events-port";
import type { GithubRelationshipPendingRefRepo } from "@scarn/core/integrations/github-ingest/application/github-relationship-pending-ref-repo";
import type { ProjectIntegrationRepo } from "@scarn/core/integrations/project-integration/application/project-integration-repo";
import { isUserCredentialIntegration } from "@scarn/core/integrations/project-integration/domain/project-integration-entity";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { SecretRepo } from "@scarn/core/secrets/secret/application/secret-repo";
import type { SecretCipher } from "@scarn/core/secrets/secret/application/secret-cipher";
import { noopLogger, type Logger } from "@scarn/observability/logging";
import { upsertWorkItems } from "@scarn/core/work-items/work-item/application/upsert-work-item";
import { runWithConcurrency } from "@scarn/core/lib/run-with-concurrency";
import { createGitHubRateLimitSignal } from "@scarn/core/integrations/github-ingest/infra/github-rate-limit";
import { runProjectIntegrationSync } from "./run-project-integration-sync";

export type ReconcileActiveIntegrationsDeps = {
  projectIntegrationRepo: ProjectIntegrationRepo;
  projectRepo: ProjectRepo;
  workItemRepo: WorkItemRepo;
  workItemBlockRepo: WorkItemBlockRepo;
  workItemEvents: WorkItemEventsPort;
  githubRelationshipPendingRefRepo: GithubRelationshipPendingRefRepo;
  secretRepo: SecretRepo;
  secretCipher: SecretCipher;
  timeProvider: TimeProvider;
  githubApp: {
    appId: string;
    privateKey: string;
  };
  logger?: Logger;
  fetchImpl?: typeof fetch;
};

export type ReconcileActiveIntegrationsResult = {
  integrationsAttempted: number;
  integrationsSucceeded: number;
  integrationsFailed: number;
};

/**
 * Hardcoded bounded-concurrency pool size for the reconcile sweep (decision
 * 17 of the GitHub sync reconciliation plan). Not configurable/env-driven —
 * a single invocation's wall-clock time is bounded by
 * `ceil(integrationCount / RECONCILE_CONCURRENCY)` sequential syncs rather
 * than scaling linearly with the total integration count.
 */
const RECONCILE_CONCURRENCY = 5;

/**
 * Sweeps every active/errored project integration and re-runs its sync.
 *
 * Since Phase 4 (docs/plans/github-integration-sync-scaling.md), this is a
 * **drift-correction backstop**, not the primary sync path — issue-content
 * webhooks are. It runs on a demoted daily cadence
 * (`infra/github-reconcile-schedule.tf`) and exists to catch missed webhook
 * deliveries and retry `error`-status integrations, not to be the mechanism
 * that keeps work items current.
 *
 * `listActive()` pages through the table internally (keyset pagination, no
 * unbounded `select`) and this function fans the returned integrations out
 * to a fixed pool of `RECONCILE_CONCURRENCY` concurrent workers rather than
 * a serial `for...of` loop, so wall-clock time no longer scales linearly
 * with total integration count. Per-integration failures are still isolated
 * by a try/catch inside the worker — one bad integration never blocks or
 * fails the rest (§5, §9 of the GitHub sync reconciliation plan).
 *
 * Scope decision: every `user_credential` integration (GitHub token,
 * Bitbucket or Jira) is skipped entirely (not counted as attempted,
 * succeeded, or failed). Those sign in with a person's credential: the ones
 * a project member lent a key to are synced by `pollLentKeyIntegrations`,
 * and the rest only sync when someone runs a sync with their own key.
 */
export const reconcileActiveIntegrations = async (
  deps: ReconcileActiveIntegrationsDeps,
): Promise<ReconcileActiveIntegrationsResult> => {
  const logger = deps.logger ?? noopLogger;
  const integrations = (await deps.projectIntegrationRepo.listActive()).filter(
    (integration) => !isUserCredentialIntegration(integration),
  );
  const userAuthz = new SystemAuthorizationService(deps.projectRepo);
  const rateLimitSignal = createGitHubRateLimitSignal(logger);

  let integrationsAttempted = 0;
  let integrationsSucceeded = 0;
  let integrationsFailed = 0;

  await runWithConcurrency(
    integrations,
    RECONCILE_CONCURRENCY,
    async (integration) => {
      // Decision 9/18 (github-integration-sync-scaling plan, Phase 5): once
      // any call this run has tripped the rate-limit floor, stop starting
      // new integrations — not attempted, not counted as failed — and let
      // the next scheduled run pick them back up. Work already dispatched
      // to other pool workers is left to finish; this only gates new work.
      if (rateLimitSignal.isExhausted) return;

      integrationsAttempted += 1;
      try {
        await runProjectIntegrationSync(
          {
            projectId: integration.projectId,
            integrationId: integration.id,
            githubApp: deps.githubApp,
            cause: "scheduled",
          },
          {
            userAuthz,
            projectIntegrationRepo: deps.projectIntegrationRepo,
            workItemRepo: deps.workItemRepo,
            workItemBlockRepo: deps.workItemBlockRepo,
            workItemEvents: deps.workItemEvents,
            githubRelationshipPendingRefRepo:
              deps.githubRelationshipPendingRefRepo,
            upsertWorkItems: (items, workItemEvents) =>
              upsertWorkItems(items, {
                userAuthz,
                workItemRepo: deps.workItemRepo,
                workItemBlockRepo: deps.workItemBlockRepo,
                workItemEvents,
                timeProvider: deps.timeProvider,
              }),
            secretRepo: deps.secretRepo,
            secretCipher: deps.secretCipher,
            timeProvider: deps.timeProvider,
            logger: deps.logger,
            fetchImpl: deps.fetchImpl,
            githubRateLimitSignal: rateLimitSignal,
          },
        );
        integrationsSucceeded += 1;
      } catch (err: unknown) {
        integrationsFailed += 1;
        logger.error(
          {
            err,
            integrationId: integration.id,
            projectId: integration.projectId,
          },
          "Scheduled reconciliation failed for integration",
        );
      }
    },
  );

  return { integrationsAttempted, integrationsSucceeded, integrationsFailed };
};
