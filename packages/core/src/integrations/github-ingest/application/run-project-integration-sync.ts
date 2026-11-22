import { CoreError, CoreValidationError } from "@scarn/core/lib/errors";
import { assertNever } from "@scarn/core/lib/assert-never";
import { markProjectIntegrationError } from "@scarn/core/integrations/project-integration/application/mark-project-integration-synced";
import { JiraIngestError } from "@scarn/core/integrations/jira-ingest/infra/jira-issues-client";
import { BitbucketApiError } from "@scarn/core/integrations/bitbucket-ingest/infra/bitbucket-client";
import { syncJiraIntegration } from "@scarn/core/integrations/jira-ingest/application/sync-jira-integration";
import type { GitHubProjectIntegration } from "@scarn/core/integrations/project-integration/domain/project-integration-entity";
import { resolveGitHubCredential } from "@scarn/core/secrets/secret/application/resolve-github-credential";
import { resolveJiraCredential } from "@scarn/core/secrets/secret/application/resolve-jira-credential";
import { noopLogger } from "@scarn/observability/logging";
import type {
  ProjectIntegrationSyncResult,
  RunProjectIntegrationSyncDeps,
  RunProjectIntegrationSyncInput,
} from "./project-integration-sync-types";
import { resolveGitHubAccessToken } from "./resolve-github-access-token";
import { syncBitbucketIntegration } from "./sync-bitbucket-integration";
import { syncGitHubIntegration } from "./sync-github-integration";

export type {
  ProjectIntegrationSyncResult,
  RunProjectIntegrationSyncDeps,
  RunProjectIntegrationSyncInput,
} from "./project-integration-sync-types";
export {
  DEFAULT_FIRST_SYNC_HORIZON_DAYS,
  OVERLAP_WINDOW_MS,
} from "./sync-github-integration";

const resolveCallerGitHubAccess = async (
  integration: GitHubProjectIntegration,
  input: RunProjectIntegrationSyncInput,
  deps: RunProjectIntegrationSyncDeps,
) =>
  resolveGitHubAccessToken(
    {
      integration,
      githubApp: input.githubApp,
      credential:
        integration.kind === "github_token"
          ? await resolveGitHubCredential(input.credential, deps)
          : undefined,
    },
    deps,
  );

/**
 * Syncs one project integration by resolving the caller's credential and
 * handing it to its platform's sync, then records any failure on the
 * integration. Each platform lives in its own `sync-<platform>-integration.ts`.
 */
export const runProjectIntegrationSync = async (
  input: RunProjectIntegrationSyncInput,
  deps: RunProjectIntegrationSyncDeps,
): Promise<ProjectIntegrationSyncResult> => {
  const logger = deps.logger ?? noopLogger;
  await deps.userAuthz.requireProjectPermission({
    projectId: input.projectId,
    permission: "work-items:write",
  });

  const integration = await deps.projectIntegrationRepo.findById(
    input.integrationId,
  );
  if (!integration || integration.projectId !== input.projectId) {
    throw new CoreValidationError(
      "Project integration not found",
      "PROJECT_INTEGRATION_NOT_FOUND",
    );
  }

  try {
    switch (integration.kind) {
      case "github_app":
      case "github_token":
        return await syncGitHubIntegration(
          integration,
          await resolveCallerGitHubAccess(integration, input, deps),
          { ...deps, logger },
        );
      case "bitbucket":
        return await syncBitbucketIntegration(integration, input, deps);
      case "jira":
        return await syncJiraIntegration(
          integration,
          await resolveJiraCredential(input.credential, deps),
          deps,
        );
      default:
        return assertNever(integration);
    }
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Unknown sync error";

    const logContext: Record<string, unknown> = {
      integrationId: integration.id,
      projectId: input.projectId,
      kind: integration.kind,
      platform: integration.platform,
      cause: input.cause,
      err: error,
    };
    if (error instanceof JiraIngestError) {
      logContext["jiraStatus"] = error.status;
      if (error.responseBody) {
        logContext["jiraResponseBody"] = error.responseBody;
      }
    }
    if (error instanceof BitbucketApiError) {
      logContext["bitbucketStatus"] = error.status;
    }
    logger.error(logContext, "Project integration sync failed");

    await markProjectIntegrationError(
      integration.id,
      message,
      deps.timeProvider.now(),
      deps.projectIntegrationRepo,
    );
    if (error instanceof CoreError || error instanceof CoreValidationError) {
      throw error;
    }
    throw new CoreError({
      code: "PROJECT_INTEGRATION_SYNC_FAILED",
      message,
      status: 502,
    });
  }
};
