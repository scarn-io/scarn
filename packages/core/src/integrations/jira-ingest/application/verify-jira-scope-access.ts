import { CoreError } from "@scarn/core/lib/errors";
import {
  fetchJiraMyself,
  JiraIngestError,
  jiraProjectExists,
  type JiraAccount,
} from "@scarn/core/integrations/jira-ingest/infra/jira-issues-client";
import {
  jiraCredentialRejectedError,
  type ResolvedJiraCredential,
} from "@scarn/core/secrets/secret/application/resolve-jira-credential";

export type JiraScope = { baseUrl: string; projectKeys: readonly string[] };

const jiraRequestFailedError = (): CoreError =>
  new CoreError({
    code: "JIRA_REQUEST_FAILED",
    message: "Couldn't reach that Jira site. Check the site URL.",
    status: 502,
  });

/**
 * Checks a resolved Jira credential can sign in to `baseUrl` and see every
 * project in `projectKeys`. Throws `JIRA_API_KEY_REJECTED` on a 401,
 * `JIRA_PROJECT_NOT_FOUND` naming the missing keys, or `JIRA_REQUEST_FAILED`
 * for anything else; never writes.
 */
export const verifyJiraScopeAccess = async (
  scope: JiraScope,
  credential: ResolvedJiraCredential,
): Promise<JiraAccount> => {
  const connection = {
    baseUrl: scope.baseUrl,
    email: credential.email,
    apiToken: credential.apiToken,
  };
  try {
    const account = await fetchJiraMyself(connection);
    const missing: string[] = [];
    for (const projectKey of scope.projectKeys) {
      if (!(await jiraProjectExists({ ...connection, projectKey }))) {
        missing.push(projectKey);
      }
    }
    if (missing.length > 0) {
      throw new CoreError({
        code: "JIRA_PROJECT_NOT_FOUND",
        message: `That Jira account can't see project ${missing.join(", ")}. Check the project keys.`,
        status: 422,
      });
    }
    return account;
  } catch (error: unknown) {
    if (error instanceof CoreError) {
      throw error;
    }
    if (error instanceof JiraIngestError && error.status === 401) {
      throw jiraCredentialRejectedError(credential);
    }
    throw jiraRequestFailedError();
  }
};
