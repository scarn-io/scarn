import { SystemAuthorizationService } from "@scarn/core/access/authorization/infra/system-authorization-service";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { GithubRelationshipPendingRefRepo } from "@scarn/core/integrations/github-ingest/application/github-relationship-pending-ref-repo";
import type { RunProjectIntegrationSyncDeps } from "@scarn/core/integrations/github-ingest/application/project-integration-sync-types";
import { syncGitHubIntegration } from "@scarn/core/integrations/github-ingest/application/sync-github-integration";
import {
  createGitHubRateLimitSignal,
  type GitHubRateLimitSignal,
} from "@scarn/core/integrations/github-ingest/infra/github-rate-limit";
import {
  JIRA_SCHEDULED_OVERLAP_MS,
  syncJiraIntegration,
} from "@scarn/core/integrations/jira-ingest/application/sync-jira-integration";
import { assertNever } from "@scarn/core/lib/assert-never";
import type { DbExecutor } from "@scarn/core/lib/db/db-executor";
import { InvariantViolationError } from "@scarn/core/lib/errors";
import { runWithConcurrency } from "@scarn/core/lib/run-with-concurrency";
import type { NotifyIntegrationAutoSyncPausedDeps } from "@scarn/core/notifications/user-notification/application/notify-integration-auto-sync-paused";
import type { TimeProvider } from "@scarn/core/lib/time-provider";
import type { ProjectRepo } from "@scarn/core/projects/project/application/project-repo";
import { markLentSecretUsed } from "@scarn/core/secrets/secret/application/mark-secret-used";
import { resolveIntegrationSyncCredential } from "@scarn/core/secrets/secret/application/resolve-integration-sync-credential";
import type { SecretCipher } from "@scarn/core/secrets/secret/application/secret-cipher";
import type { SecretRepo } from "@scarn/core/secrets/secret/application/secret-repo";
import { upsertWorkItems } from "@scarn/core/work-items/work-item/application/upsert-work-item";
import type { WorkItemEventsPort } from "@scarn/core/work-items/work-item/application/work-item-events-port";
import type { WorkItemRepo } from "@scarn/core/work-items/work-item/application/work-item-repo";
import type { WorkItemBlockRepo } from "@scarn/core/work-items/work-item-block/application/work-item-block-repo";
import { noopLogger, type Logger } from "@scarn/observability/logging";
import type { ProjectIntegrationEntity } from "../domain/project-integration-entity";
import { classifyAutoSyncFailure } from "./classify-auto-sync-failure";
import { markProjectIntegrationError } from "./mark-project-integration-synced";
import { pauseIntegrationAutoSync } from "./pause-integration-auto-sync";
import type { ProjectIntegrationRepo } from "./project-integration-repo";

export type PollLentKeyIntegrationsDeps = {
  projectIntegrationRepo: ProjectIntegrationRepo;
  projectRepo: ProjectRepo;
  workItemRepo: WorkItemRepo;
  workItemBlockRepo: WorkItemBlockRepo;
  workItemEvents: WorkItemEventsPort;
  githubRelationshipPendingRefRepo: GithubRelationshipPendingRefRepo;
  secretRepo: SecretRepo;
  secretCipher: SecretCipher;
  /** Notifies people when an integration pauses. */
  notifications: NotifyIntegrationAutoSyncPausedDeps;
  timeProvider: TimeProvider;
  logger?: Logger;
  /** Where each pause opens its transaction; defaults to `getDb()`. */
  dbExecutor?: DbExecutor;
  fetchImpl?: typeof fetch;
  /** Overrides the Jira sync; tests use it since the Jira client takes no `fetch`. */
  syncJira?: typeof syncJiraIntegration;
};

/**
 * Every integration the poller claimed and tried to sync is `attempted`,
 * and ends up in exactly one of `succeeded`, `failed`, `paused` or
 * `skippedRateLimited`. `skippedLocked` (another run holds the claim) and
 * `skippedRateLimited` for a key whose GitHub budget ran out before the
 * integration started are not attempted.
 */
export type PollLentKeyIntegrationsResult = {
  attempted: number;
  succeeded: number;
  failed: number;
  paused: number;
  skippedLocked: number;
  skippedRateLimited: number;
};

const POLL_CONCURRENCY = 5;

/** How long a claim holds off other runs; shorter than the 10-minute daytime tick. */
const SYNC_CLAIM_MS = 4 * 60 * 1000;

type Outcome = "succeeded" | "failed" | "paused" | "rate_limited";

/**
 * Syncs every integration a project member lent a key to (see
 * `listDueForAutoSync`), as the system actor. Each integration is claimed
 * first so overlapping runs never sync it twice, and released afterwards.
 *
 * A lent key that is rejected, missing, expired, owned by someone who left
 * the project, or that lost access to a GitHub repo pauses auto-sync through
 * `pauseIntegrationAutoSync`. A rate limit skips the integration this tick.
 * Any other failure is recorded as a sync error and retried next tick. One
 * integration failing never stops the others.
 *
 * GitHub budgets are per token, so each lent GitHub key gets its own
 * rate-limit signal; once a key's budget runs low its remaining
 * integrations are skipped while other keys' integrations still sync.
 */
export const pollLentKeyIntegrations = async (
  deps: PollLentKeyIntegrationsDeps,
): Promise<PollLentKeyIntegrationsResult> => {
  const logger = deps.logger ?? noopLogger;
  const syncJira = deps.syncJira ?? syncJiraIntegration;
  const userAuthz = new SystemAuthorizationService(deps.projectRepo);
  const syncDeps: RunProjectIntegrationSyncDeps = {
    userAuthz,
    projectIntegrationRepo: deps.projectIntegrationRepo,
    workItemRepo: deps.workItemRepo,
    workItemBlockRepo: deps.workItemBlockRepo,
    workItemEvents: deps.workItemEvents,
    githubRelationshipPendingRefRepo: deps.githubRelationshipPendingRefRepo,
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
    logger,
    fetchImpl: deps.fetchImpl,
  };

  const signals = new Map<UuidV7, GitHubRateLimitSignal>();
  const signalFor = (secretId: UuidV7): GitHubRateLimitSignal => {
    let signal = signals.get(secretId);
    if (!signal) {
      signal = createGitHubRateLimitSignal(logger);
      signals.set(secretId, signal);
    }
    return signal;
  };
  const isGitHubBudgetExhausted = (integration: ProjectIntegrationEntity) =>
    integration.kind === "github_token" &&
    integration.syncSecretId !== null &&
    signals.get(integration.syncSecretId)?.isExhausted === true;

  const syncLent = async (
    integration: ProjectIntegrationEntity,
    lentSecretId: UuidV7,
  ): Promise<void> => {
    const resolved = await resolveIntegrationSyncCredential(integration, deps);
    switch (integration.kind) {
      case "jira":
        if (resolved.kind !== "jira") break;
        await syncJira(integration, resolved.credential, syncDeps, {
          overlapMs: JIRA_SCHEDULED_OVERLAP_MS,
        });
        return;
      case "github_token":
        if (resolved.kind !== "github_token") break;
        await syncGitHubIntegration(integration, resolved.credential, {
          ...syncDeps,
          githubRateLimitSignal: signalFor(lentSecretId),
        });
        return;
      case "github_app":
      case "bitbucket":
        break;
      default:
        return assertNever(integration);
    }
    throw new InvariantViolationError(
      `Project integration ${integration.id} of kind '${integration.kind}' got a '${resolved.kind}' credential`,
    );
  };

  const syncClaimed = async (
    integration: ProjectIntegrationEntity,
    lentSecretId: UuidV7,
  ): Promise<Outcome> => {
    try {
      await syncLent(integration, lentSecretId);
    } catch (error: unknown) {
      const failure = classifyAutoSyncFailure(error);
      const logContext = {
        integrationId: integration.id,
        projectId: integration.projectId,
        kind: integration.kind,
      };
      switch (failure.type) {
        case "pause":
          await pauseIntegrationAutoSync(
            {
              integrationId: integration.id,
              lentSecretId,
              reason: failure.reason,
              detail: failure.detail,
            },
            { ...deps, logger },
          );
          return "paused";
        case "rate_limited":
          logger.warn(logContext, "Auto-sync rate limited; skipping this tick");
          return "rate_limited";
        case "error":
          logger.error({ ...logContext, err: error }, "Auto-sync failed");
          await markProjectIntegrationError(
            integration.id,
            failure.message,
            deps.timeProvider.now(),
            deps.projectIntegrationRepo,
          );
          return "failed";
        default:
          return assertNever(failure);
      }
    }
    try {
      await markLentSecretUsed(lentSecretId, deps);
    } catch (error: unknown) {
      logger.error(
        { err: error, integrationId: integration.id },
        "Failed to mark lent key used after auto-sync",
      );
    }
    return "succeeded";
  };

  const result: PollLentKeyIntegrationsResult = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    paused: 0,
    skippedLocked: 0,
    skippedRateLimited: 0,
  };
  const count = (outcome: Outcome) => {
    result.attempted += 1;
    if (outcome === "rate_limited") result.skippedRateLimited += 1;
    else result[outcome] += 1;
  };

  const integrations = await deps.projectIntegrationRepo.listDueForAutoSync();

  await runWithConcurrency(integrations, POLL_CONCURRENCY, async (listed) => {
    if (isGitHubBudgetExhausted(listed)) {
      result.skippedRateLimited += 1;
      return;
    }

    const claimUntil = new Date(
      deps.timeProvider.now().getTime() + SYNC_CLAIM_MS,
    );
    let claimed = false;
    try {
      claimed = await deps.projectIntegrationRepo.claimForSync(
        listed.id,
        claimUntil,
      );
      if (!claimed) {
        result.skippedLocked += 1;
        return;
      }

      const integration = await deps.projectIntegrationRepo.findById(listed.id);
      if (
        !integration ||
        integration.syncSecretId === null ||
        integration.status === "paused"
      ) {
        return;
      }
      if (isGitHubBudgetExhausted(integration)) {
        result.skippedRateLimited += 1;
        return;
      }

      count(await syncClaimed(integration, integration.syncSecretId));
    } catch (error: unknown) {
      result.attempted += 1;
      result.failed += 1;
      logger.error(
        { err: error, integrationId: listed.id, projectId: listed.projectId },
        "Auto-sync poller failed to process integration",
      );
    } finally {
      if (claimed) {
        try {
          await deps.projectIntegrationRepo.releaseSyncClaim(listed.id);
        } catch (error: unknown) {
          logger.error(
            { err: error, integrationId: listed.id },
            "Failed to release auto-sync claim",
          );
        }
      }
    }
  });

  return result;
};
