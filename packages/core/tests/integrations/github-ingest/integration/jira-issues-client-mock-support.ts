/**
 * `mock.module` harness for `@/integrations/jira-ingest/infra/jira-issues-client`
 * so a Jira sync can run end to end through the real API without calling
 * Jira. The network functions are swapped at the module seam (the same one
 * `ingest-jira-issues.test.ts` uses) rather than by faking `fetch`. Every call's connection input is recorded so tests can assert which
 * email and token reached "Jira".
 *
 * `mock.restore()` does not undo `mock.module`: files using this must run
 * serially and await `uninstallJiraIssuesClientMock()` in `afterEach`.
 */

import { mock } from "bun:test";
import {
  buildJiraSearchJql,
  fetchJiraAccountTimeZone,
  fetchJiraFieldNameMap,
  fetchJiraIssues,
  fetchJiraMyself,
  formatJiraDateTimeInZone,
  JiraIngestError,
  jiraProjectExists,
  type JiraConnectionInput,
} from "@/integrations/jira-ingest/infra/jira-issues-client";

const REAL_EXPORTS = {
  buildJiraSearchJql,
  fetchJiraAccountTimeZone,
  fetchJiraFieldNameMap,
  fetchJiraIssues,
  fetchJiraMyself,
  formatJiraDateTimeInZone,
  JiraIngestError,
  jiraProjectExists,
};

const MODULE_PATH = "@/integrations/jira-ingest/infra/jira-issues-client";

export type CapturedJiraConnection = Pick<
  JiraConnectionInput,
  "baseUrl" | "email" | "apiToken"
>;

/** Canned Jira 401 response body. Tests assert it never reaches the user. */
export const JIRA_UNAUTHORIZED_RESPONSE_BODY =
  '{"errorMessages":["Client must be authenticated to access this resource."]}';

export const installJiraIssuesClientMock = async (
  options: { failureStatus?: number; missingProjectKeys?: string[] } = {},
): Promise<{ calls: CapturedJiraConnection[] }> => {
  const calls: CapturedJiraConnection[] = [];
  const record = (input: JiraConnectionInput) => {
    calls.push({
      baseUrl: input.baseUrl,
      email: input.email,
      apiToken: input.apiToken,
    });
    if (options.failureStatus !== undefined) {
      return Promise.reject(
        new JiraIngestError(
          `Jira returned ${String(options.failureStatus)} fetching field names`,
          options.failureStatus,
          JIRA_UNAUTHORIZED_RESPONSE_BODY,
        ),
      );
    }
    return Promise.resolve();
  };

  await mock.module(MODULE_PATH, () => ({
    ...REAL_EXPORTS,
    fetchJiraFieldNameMap: async (input: JiraConnectionInput) => {
      await record(input);
      return new Map<string, string>();
    },
    fetchJiraAccountTimeZone: async (input: JiraConnectionInput) => {
      await record(input);
      return "UTC";
    },
    fetchJiraIssues: async (input: JiraConnectionInput) => {
      await record(input);
      return [];
    },
    fetchJiraMyself: async (input: JiraConnectionInput) => {
      await record(input);
      return {
        accountId: "jira-account-1",
        displayName: "Jira Tester",
        emailAddress: input.email,
      };
    },
    jiraProjectExists: async (
      input: JiraConnectionInput & { projectKey: string },
    ) => {
      await record(input);
      return !(options.missingProjectKeys ?? []).includes(input.projectKey);
    },
  }));

  return { calls };
};

export const uninstallJiraIssuesClientMock = async (): Promise<void> => {
  await mock.module(MODULE_PATH, () => ({ ...REAL_EXPORTS }));
};
