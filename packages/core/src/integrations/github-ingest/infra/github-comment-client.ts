/**
 * Outbound GitHub comment posting.
 *
 * Mirrors the raw-`fetch` style of `github-issues-client.ts` (headers,
 * `fetchImpl` escape hatch for testability) and the error-handling shape of
 * `mint-installation-token.ts` (defensive JSON error-body parsing, typed
 * error with a `status` field). No `octokit` dependency is introduced.
 *
 * This is the first *outbound write* to GitHub in this codebase — every
 * other GitHub client in this package only reads (`fetchRepoIssues`, etc).
 */

const githubHeaders = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "scarn",
});

export type PostIssueCommentInput = {
  installationToken: string;
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
  fetchImpl?: typeof fetch;
};

export type PostedGitHubComment = {
  id: string;
  htmlUrl: string;
};

type PostIssueCommentResponseBody = {
  id?: number;
  html_url?: string;
  message?: string;
};

export class GitHubCommentError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GitHubCommentError";
  }
}

export async function postIssueComment({
  installationToken,
  owner,
  repo,
  issueNumber,
  body,
  fetchImpl = fetch,
}: PostIssueCommentInput): Promise<PostedGitHubComment> {
  const response = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/issues/${String(issueNumber)}/comments`,
    {
      method: "POST",
      headers: {
        ...githubHeaders(installationToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ body }),
    },
  );

  if (!response.ok) {
    const errorBody = (await response
      .json()
      .catch(() => null)) as PostIssueCommentResponseBody | null;
    throw new GitHubCommentError(
      `GitHub returned ${String(response.status)} while posting a comment to ${owner}/${repo}#${String(issueNumber)}` +
        (errorBody?.message ? `: ${errorBody.message}` : ""),
      response.status,
    );
  }

  const responseBody =
    (await response.json()) as PostIssueCommentResponseBody;
  if (responseBody.id === undefined || !responseBody.html_url) {
    throw new GitHubCommentError(
      `GitHub comment response for ${owner}/${repo}#${String(issueNumber)} missing id or html_url`,
      response.status,
    );
  }

  return {
    id: String(responseBody.id),
    htmlUrl: responseBody.html_url,
  };
}
