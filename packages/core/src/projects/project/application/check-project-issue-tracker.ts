import { parseGitHost } from "@scarn/sdk/git-url";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { assertNever } from "@scarn/core/lib/assert-never";
import {
  issueTrackerCheckInputSchema,
  type IssueTrackerCheckRequest,
  type IssueTrackerCheckResponse,
} from "../contracts/project-setup-contracts";
import {
  verifyIssueTrackerAccess,
  type VerifyIssueTrackerAccessDeps,
} from "./verify-issue-tracker-access";

/**
 * Checks a GitHub token, Bitbucket API token or Jira credential against this
 * repo or Jira site before anything is created. Writes nothing: not a
 * project, an integration or a secret, and not a saved key's `lastUsedAt`.
 */
export const checkProjectIssueTracker = async (
  input: IssueTrackerCheckRequest & { userId: UuidV7 },
  deps: VerifyIssueTrackerAccessDeps,
): Promise<IssueTrackerCheckResponse> => {
  const { gitUrl, issueTracker } = issueTrackerCheckInputSchema.parse(input);
  const access = await verifyIssueTrackerAccess(
    { userId: input.userId, host: parseGitHost(gitUrl), issueTracker },
    deps,
  );
  switch (access.type) {
    case "github_token":
      return {
        ok: true,
        account: access.account,
        issuesEnabled: access.issuesEnabled,
        repo: access.repo,
      };
    case "bitbucket":
      return {
        ok: true,
        account: access.account,
        issuesEnabled: true,
        repo: null,
      };
    case "jira":
      return {
        ok: true,
        account: access.account,
        issuesEnabled: true,
        repo: null,
      };
    case "github_app":
      return {
        ok: true,
        account: access.repo.fullName,
        issuesEnabled: true,
        repo: access.repo,
      };
    default:
      return assertNever(access);
  }
};
