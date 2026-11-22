import type { BitbucketProjectIntegration } from "@scarn/core/integrations/project-integration/domain/project-integration-entity";
import { markProjectIntegrationSynced } from "@scarn/core/integrations/project-integration/application/mark-project-integration-synced";
import { ingestBitbucketIssues } from "@scarn/core/integrations/bitbucket-ingest/application/ingest-bitbucket-issues";
import {
  BitbucketApiError,
  createBitbucketClient,
} from "@scarn/core/integrations/bitbucket-ingest/infra/bitbucket-client";
import {
  bitbucketCredentialRejectedError,
  resolveBitbucketCredential,
} from "@scarn/core/secrets/secret/application/resolve-bitbucket-credential";
import { markSecretUsed } from "@scarn/core/secrets/secret/application/mark-secret-used";
import {
  DEFAULT_FIRST_SYNC_HORIZON_DAYS,
  OVERLAP_WINDOW_MS,
} from "./sync-github-integration";
import type {
  ProjectIntegrationSyncResult,
  RunProjectIntegrationSyncDeps,
  RunProjectIntegrationSyncInput,
} from "./project-integration-sync-types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Syncs a Bitbucket integration's repos' issues with the requesting user's
 * Atlassian email + API token, using the same overlap window and first-sync
 * horizon as GitHub. A 401 becomes `BITBUCKET_API_TOKEN_REJECTED`.
 */
export const syncBitbucketIntegration = async (
  integration: BitbucketProjectIntegration,
  input: RunProjectIntegrationSyncInput,
  deps: RunProjectIntegrationSyncDeps,
): Promise<ProjectIntegrationSyncResult> => {
  const credential = await resolveBitbucketCredential(input.credential, deps);

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

  const client = createBitbucketClient({
    email: credential.email,
    apiToken: credential.apiToken,
    secretName: credential.secretName,
    fetchImpl: deps.fetchImpl,
  });

  try {
    const result = await ingestBitbucketIssues(
      {
        projectId: input.projectId,
        repos: integration.scope.repos,
        sinceIso,
      },
      client,
      (items) => deps.upsertWorkItems(items, deps.workItemEvents),
    );

    await markProjectIntegrationSynced(
      integration.id,
      result.maxSourceUpdatedAt
        ? new Date(result.maxSourceUpdatedAt)
        : runStartedAt,
      deps.projectIntegrationRepo,
    );
    await markSecretUsed(credential.secretId, deps);

    return {
      totalUpserted: result.totalUpserted,
      perSource: result.perRepo.map((r) => ({
        key: r.fullName,
        totalSeen: r.totalSeen,
        totalUpserted: r.totalUpserted,
      })),
    };
  } catch (error: unknown) {
    if (error instanceof BitbucketApiError && error.status === 401) {
      throw bitbucketCredentialRejectedError(credential);
    }
    throw error;
  }
};
