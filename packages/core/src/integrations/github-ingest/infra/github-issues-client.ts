import {
  isGitHubRateLimitResponse,
  type GitHubRateLimitSignal,
} from "./github-rate-limit";

export type GitHubIssueLabel = {
  name?: string;
};

export type GitHubIssueUser = {
  login?: string;
};

export type GitHubIssue = {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  state_reason?: string | null;
  user?: GitHubIssueUser | null;
  labels?: Array<GitHubIssueLabel | string>;
  assignees?: GitHubIssueUser[];
  comments?: number;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  pull_request?: unknown;
};

const githubHeaders = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "scarn",
});

const parseLinkHeader = (header: string | null): Record<string, string> => {
  if (!header) return {};
  const links: Record<string, string> = {};
  for (const part of header.split(",")) {
    const match = /<([^>]+)>;\s*rel="([^"]+)"/.exec(part.trim());
    if (match?.[1] && match[2]) {
      links[match[2]] = match[1];
    }
  }
  return links;
};

export type FetchRepoIssuesInput = {
  accessToken: string;
  owner: string;
  repo: string;
  sinceIso?: string | null;
  fetchImpl?: typeof fetch;
  rateLimitSignal?: GitHubRateLimitSignal;
};

export type GitHubIngestErrorDetails = {
  /** The `owner/name` repo being fetched, when the failure is about one. */
  repoFullName?: string;
  /** GitHub sent `X-GitHub-SSO`: the token needs SAML SSO authorization. */
  ssoRequired?: boolean;
  /** GitHub rate-limited the call (see `isGitHubRateLimitResponse`). */
  rateLimited?: boolean;
};

export class GitHubIngestError extends Error {
  public readonly repoFullName: string | undefined;
  public readonly ssoRequired: boolean;
  public readonly rateLimited: boolean;

  constructor(
    message: string,
    public readonly status: number,
    details: GitHubIngestErrorDetails = {},
  ) {
    super(message);
    this.name = "GitHubIngestError";
    this.repoFullName = details.repoFullName;
    this.ssoRequired = details.ssoRequired ?? false;
    this.rateLimited = details.rateLimited ?? false;
  }
}

/**
 * Builds the error for a failed GitHub response, reading whether it was an
 * SSO-enforcement 403 or a rate limit from its headers.
 */
export const gitHubIngestErrorFromResponse = (
  message: string,
  response: Pick<Response, "status" | "headers">,
  repoFullName?: string,
): GitHubIngestError =>
  new GitHubIngestError(message, response.status, {
    repoFullName,
    ssoRequired:
      response.status === 403 && response.headers.get("x-github-sso") !== null,
    rateLimited: isGitHubRateLimitResponse(response),
  });

export async function fetchRepoIssues({
  accessToken,
  owner,
  repo,
  sinceIso,
  fetchImpl = fetch,
  rateLimitSignal,
}: FetchRepoIssuesInput): Promise<GitHubIssue[]> {
  const initialUrl = new URL(
    `https://api.github.com/repos/${owner}/${repo}/issues`,
  );
  initialUrl.searchParams.set("state", "all");
  initialUrl.searchParams.set("per_page", "100");
  initialUrl.searchParams.set("sort", "updated");
  initialUrl.searchParams.set("direction", "asc");
  if (sinceIso) initialUrl.searchParams.set("since", sinceIso);

  const issues: GitHubIssue[] = [];
  let nextUrl: string | null = initialUrl.toString();
  while (nextUrl) {
    const response = await fetchImpl(nextUrl, {
      headers: githubHeaders(accessToken),
    });
    rateLimitSignal?.recordResponse(response);
    if (!response.ok) {
      throw gitHubIngestErrorFromResponse(
        `GitHub returned ${String(response.status)} fetching ${owner}/${repo} issues`,
        response,
        `${owner}/${repo}`,
      );
    }
    const page = (await response.json()) as GitHubIssue[];
    issues.push(...page);
    const links = parseLinkHeader(response.headers.get("link"));
    nextUrl = links["next"] ?? null;
  }
  return issues;
}

export const splitRepoFullName = (
  fullName: string,
): { owner: string; repo: string } => {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) {
    throw new GitHubIngestError(
      `Invalid repository full name: ${fullName}`,
      400,
    );
  }
  return { owner, repo };
};
