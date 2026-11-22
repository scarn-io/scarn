import type { GitHubProjectIntegration } from "@scarn/core/integrations/project-integration/domain/project-integration-entity";
import { markProjectIntegrationSynced } from "@scarn/core/integrations/project-integration/application/mark-project-integration-synced";
import { GitHubIngestError } from "@scarn/core/integrations/github-ingest/infra/github-issues-client";
import { githubCredentialRejectedError } from "@scarn/core/secrets/secret/application/resolve-github-credential";
import { markSecretUsed } from "@scarn/core/secrets/secret/application/mark-secret-used";
import { getDb } from "@scarn/core/lib/db";
import { DeferredWorkItemEvents } from "@scarn/core/work-items/work-item/application/deferred-work-item-events";
import { noopLogger } from "@scarn/observability/logging";
import { ingestGitHubIssues } from "./ingest-github-issues";
import { ingestGitHubIssueRelationships } from "./ingest-github-issue-relationships";
import type { ResolvedGitHubAccessToken } from "./resolve-github-access-token";
import type {
  ProjectIntegrationSyncResult,
  RunProjectIntegrationSyncDeps,
} from "./project-integration-sync-types";

/**
 * How far before `lastSyncedAt` to re-fetch on an incremental sync, so that
 * issues updated right at (or just before) the previous watermark aren't
 * missed due to timing boundaries.
 */
export const OVERLAP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Default lookback window (in days) for a never-synced integration's first
 * import, used when `firstSyncHorizonDays` is not set on the integration.
 */
export const DEFAULT_FIRST_SYNC_HORIZON_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Upserts the repos' issues, then their parent and block relationships,
 * holding the work item events back until both passes are done, so
 * readiness is judged once the blocks exist: an issue that arrives blocked
 * by another is not ready until its last blocker closes. The held events are
 * told even when a pass fails, since the writes before it have landed.
 */
const ingestIssuesAndRelationships = async (
  accessToken: string,
  sinceIso: string,
  integration: GitHubProjectIntegration,
  deps: RunProjectIntegrationSyncDeps,
) => {
  const workItemEvents = new DeferredWorkItemEvents(deps.workItemEvents);
  try {
    const result = await ingestGitHubIssues(
      {
        projectId: integration.projectId,
        accessToken,
        repos: integration.scope.repos.map((repo) => ({
          fullName: repo.fullName,
        })),
        sinceIso,
        fetchImpl: deps.fetchImpl,
        rateLimitSignal: deps.githubRateLimitSignal,
      },
      (items) => deps.upsertWorkItems(items, workItemEvents),
    );

    const relationshipsResult = await ingestGitHubIssueRelationships(
      {
        projectId: integration.projectId,
        accessToken,
        issuesByRepo: result.perRepo.map((r) => ({
          fullName: r.fullName,
          issues: r.issues,
        })),
        fetchImpl: deps.fetchImpl,
        rateLimitSignal: deps.githubRateLimitSignal,
      },
      {
        workItemRepo: deps.workItemRepo,
        workItemBlockRepo: deps.workItemBlockRepo,
        workItemEvents,
        githubRelationshipPendingRefRepo: deps.githubRelationshipPendingRefRepo,
        userAuthz: deps.userAuthz,
        timeProvider: deps.timeProvider,
        logger: deps.logger ?? noopLogger,
      },
    );
    return { result, relationshipsResult };
  } finally {
    await workItemEvents.flush(getDb());
  }
};

/**
 * Syncs a GitHub integration's repos with an already-resolved access token
 * (see `resolveGitHubAccessToken`): an App installation token, the
 * requesting user's own token, or a lent one. A 401 on a token integration
 * becomes `GITHUB_TOKEN_REJECTED`. Every GitHub response is recorded on
 * `deps.githubRateLimitSignal` when one is given.
 */
export const syncGitHubIntegration = async (
  integration: GitHubProjectIntegration,
  access: ResolvedGitHubAccessToken,
  deps: RunProjectIntegrationSyncDeps,
): Promise<ProjectIntegrationSyncResult> => {
  // Captured before any issue fetch, so a zero-issue run still has a safe
  // fallback watermark.
  const runStartedAt = deps.timeProvider.now();
  const sinceIso = integration.lastSyncedAt
    ? new Date(
        integration.lastSyncedAt.getTime() - OVERLAP_WINDOW_MS,
      ).toISOString()
    : new Date(
        runStartedAt.getTime() -
          (integration.firstSyncHorizonDays ??
            DEFAULT_FIRST_SYNC_HORIZON_DAYS) *
            MS_PER_DAY,
      ).toISOString();

  try {
    const { result, relationshipsResult } = await ingestIssuesAndRelationships(
      access.token,
      sinceIso,
      integration,
      deps,
    );

    const watermark = result.maxSourceUpdatedAt
      ? new Date(result.maxSourceUpdatedAt)
      : runStartedAt;
    await markProjectIntegrationSynced(
      integration.id,
      watermark,
      deps.projectIntegrationRepo,
    );
    await markSecretUsed(access.secretId, deps);

    return {
      totalUpserted: result.totalUpserted,
      perSource: result.perRepo.map((r) => ({
        key: r.fullName,
        totalSeen: r.totalSeen,
        totalUpserted: r.totalUpserted,
      })),
      parentLinksApplied: relationshipsResult.parentLinksApplied,
      parentLinksSkipped: relationshipsResult.parentLinksSkipped,
      blocksCreated: relationshipsResult.blocksCreated,
      blocksSkipped: relationshipsResult.blocksSkipped,
    };
  } catch (error: unknown) {
    if (
      integration.kind === "github_token" &&
      error instanceof GitHubIngestError &&
      error.status === 401
    ) {
      throw githubCredentialRejectedError(access);
    }
    throw error;
  }
};
