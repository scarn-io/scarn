import type { IssueTrackerCheckInput } from "@scarn/core/projects/project/contracts/project-setup-contracts";
import { getBrowserScarnApiClient } from "@/app/_lib/scarn-browser-api-client";
import { apiErrorCode, parseApiError } from "@/app/_lib/api-error";
import type { CredentialCheckResult } from "./token-credential-form";

/**
 * `POST /projects/issue-tracker-check`: checks a credential against the repo
 * or Jira site without creating or saving anything. Server errors already
 * explain the fix (wrong token, no repo access, unknown project key), so
 * their detail is shown as is.
 */
export async function checkIssueTracker(
  gitUrl: string,
  issueTracker: IssueTrackerCheckInput,
): Promise<CredentialCheckResult> {
  const { data, error } = await getBrowserScarnApiClient().api.projects[
    "issue-tracker-check"
  ].post({ gitUrl, issueTracker });
  if (error) {
    return {
      ok: false,
      message: parseApiError(error, "Couldn't check that token. Try again."),
      code: apiErrorCode(error),
    };
  }
  return { ok: true, account: data.account, repo: data.repo };
}
