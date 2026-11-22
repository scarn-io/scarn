import { CoreError } from "@scarn/core/lib/errors";
import { GitHubIngestError } from "@scarn/core/integrations/github-ingest/infra/github-issues-client";
import { JiraIngestError } from "@scarn/core/integrations/jira-ingest/infra/jira-issues-client";
import { AutoSyncCredentialUnusableError } from "@scarn/core/secrets/secret/application/resolve-integration-sync-credential";
import type { AutoSyncPausedReason } from "../domain/project-integration-entity";

export type AutoSyncFailure =
  | { type: "pause"; reason: AutoSyncPausedReason; detail: string | null }
  | { type: "rate_limited" }
  | { type: "error"; message: string };

const KEY_REJECTED_CODES: ReadonlySet<string> = new Set([
  "JIRA_API_KEY_REJECTED",
  "GITHUB_TOKEN_REJECTED",
]);

const classifyGitHubError = (error: GitHubIngestError): AutoSyncFailure => {
  if (error.rateLimited) {
    return { type: "rate_limited" };
  }
  const repo = error.repoFullName ?? null;
  if (error.ssoRequired) {
    return {
      type: "pause",
      reason: "access_lost",
      detail:
        repo === null
          ? "SSO authorization required"
          : `SSO authorization required for ${repo}`,
    };
  }
  if (error.status === 403 || error.status === 404) {
    return {
      type: "pause",
      reason: "access_lost",
      detail: repo === null ? null : `No access to ${repo}`,
    };
  }
  if (error.status === 401) {
    return { type: "pause", reason: "key_rejected", detail: null };
  }
  return { type: "error", message: error.message };
};

/**
 * Decides what the auto-sync poller does with a failed sync: pause it (the
 * lent key is rejected, missing, expired, its owner left, or it lost access
 * to a repo), skip it this tick (rate limited), or record an error that the
 * next tick retries. A pause `detail` never carries a key value, email or
 * response body.
 */
export const classifyAutoSyncFailure = (
  // Receives whatever a `catch` clause caught; there is no narrower type.
  // eslint-disable-next-line local/no-unknown-parameter-type
  error: unknown,
): AutoSyncFailure => {
  if (error instanceof AutoSyncCredentialUnusableError) {
    return {
      type: "pause",
      reason: error.reason,
      detail: error.detail ?? null,
    };
  }
  if (error instanceof CoreError && KEY_REJECTED_CODES.has(error.code)) {
    return { type: "pause", reason: "key_rejected", detail: null };
  }
  if (error instanceof GitHubIngestError) {
    return classifyGitHubError(error);
  }
  if (error instanceof JiraIngestError) {
    if (error.status === 401) {
      return { type: "pause", reason: "key_rejected", detail: null };
    }
    if (error.status === 429) {
      return { type: "rate_limited" };
    }
  }
  return {
    type: "error",
    message: error instanceof Error ? error.message : "Unknown sync error",
  };
};
