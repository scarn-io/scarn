import type { JiraProjectIntegration } from "@scarn/core/integrations/project-integration/domain/project-integration-entity";
import { markProjectIntegrationSynced } from "@scarn/core/integrations/project-integration/application/mark-project-integration-synced";
import { ingestJiraIssues } from "@scarn/core/integrations/jira-ingest/application/ingest-jira-issues";
import { JiraIngestError } from "@scarn/core/integrations/jira-ingest/infra/jira-issues-client";
import {
  jiraCredentialRejectedError,
  type ResolvedJiraCredential,
} from "@scarn/core/secrets/secret/application/resolve-jira-credential";
import { markSecretUsed } from "@scarn/core/secrets/secret/application/mark-secret-used";
import { DEFAULT_FIRST_SYNC_HORIZON_DAYS } from "@scarn/core/integrations/github-ingest/application/sync-github-integration";
import type {
  ProjectIntegrationSyncResult,
  RunProjectIntegrationSyncDeps,
} from "@scarn/core/integrations/github-ingest/application/project-integration-sync-types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How far before `lastSyncedAt` a scheduled Jira sync starts, so issues
 * updated around the previous run's boundary aren't missed. Manual syncs
 * use no overlap.
 */
export const JIRA_SCHEDULED_OVERLAP_MS = 2 * 60 * 1000;

export type SyncJiraIntegrationOptions = {
  /** How far before `lastSyncedAt` to start; defaults to 0. */
  overlapMs?: number;
};

export const jiraSyncSinceIso = (
  integration: Pick<
    JiraProjectIntegration,
    "lastSyncedAt" | "firstSyncHorizonDays"
  >,
  runStartedAt: Date,
  overlapMs = 0,
): string =>
  integration.lastSyncedAt
    ? new Date(integration.lastSyncedAt.getTime() - overlapMs).toISOString()
    : new Date(
        runStartedAt.getTime() -
          (integration.firstSyncHorizonDays ??
            DEFAULT_FIRST_SYNC_HORIZON_DAYS) *
            MS_PER_DAY,
      ).toISOString();

/**
 * Syncs a Jira integration's project keys with an already-resolved Jira API
 * key (the caller's own for a manual sync, the lent one for a scheduled
 * sync). A 401 becomes `JIRA_API_KEY_REJECTED`.
 */
export const syncJiraIntegration = async (
  integration: JiraProjectIntegration,
  credential: ResolvedJiraCredential,
  deps: RunProjectIntegrationSyncDeps,
  options: SyncJiraIntegrationOptions = {},
): Promise<ProjectIntegrationSyncResult> => {
  const { scope } = integration;
  const runStartedAt = deps.timeProvider.now();
  const sinceIso = jiraSyncSinceIso(
    integration,
    runStartedAt,
    options.overlapMs,
  );

  try {
    const result = await ingestJiraIssues(
      {
        projectId: integration.projectId,
        baseUrl: scope.baseUrl,
        email: credential.email,
        apiToken: credential.apiToken,
        projectKeys: scope.projectKeys,
        sinceIso,
      },
      (items) => deps.upsertWorkItems(items, deps.workItemEvents),
    );

    await markProjectIntegrationSynced(
      integration.id,
      runStartedAt,
      deps.projectIntegrationRepo,
    );
    await markSecretUsed(credential.secretId, deps);

    return {
      totalUpserted: result.totalUpserted,
      perSource: result.perProject.map((r) => ({
        key: r.key,
        totalSeen: r.totalSeen,
        totalUpserted: r.totalUpserted,
      })),
    };
  } catch (error: unknown) {
    if (error instanceof JiraIngestError && error.status === 401) {
      throw jiraCredentialRejectedError(credential);
    }
    throw error;
  }
};
