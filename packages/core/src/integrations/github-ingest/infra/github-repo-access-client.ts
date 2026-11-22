/**
 * Checks what a GitHub personal access token can see before anything is
 * saved: the repo it should read (`GET /repos/{owner}/{name}`) and the
 * account it belongs to (`GET /user`). Same raw-`fetch` style and headers as
 * `github-issues-client.ts`. Never puts the token or GitHub's response body
 * in an error.
 */
import { CoreError } from "@scarn/core/lib/errors";
import { githubCredentialRejectedError } from "@scarn/core/secrets/secret/application/resolve-github-credential";

const githubHeaders = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "scarn",
});

export type GitHubRepoAccess = {
  id: number;
  fullName: string;
  hasIssues: boolean;
};

export type GitHubTokenUser = {
  login: string;
};

export type GitHubRepoAccessOptions = {
  /** The saved key's name, so a rejection names it; null for a pasted token. */
  secretName?: string | null;
  fetchImpl?: typeof fetch;
};

type RepoResponseBody = {
  id?: number;
  full_name?: string;
  has_issues?: boolean;
};

type UserResponseBody = {
  login?: string;
};

export const githubRepoNotAccessibleError = (
  owner: string,
  name: string,
): CoreError =>
  new CoreError({
    code: "GITHUB_REPO_NOT_ACCESSIBLE",
    message:
      `That token can't read ${owner}/${name}. Check the token has access to this repository ` +
      "(a fine-grained token needs the repository selected and Issues read access), " +
      "that the organization has approved fine-grained tokens, " +
      "and that the token is authorized for the organization's SSO.",
    status: 422,
  });

const unexpectedStatusError = (status: number, what: string): CoreError =>
  new CoreError({
    code: "GITHUB_REQUEST_FAILED",
    message: `GitHub returned ${String(status)} while reading ${what}`,
    status: 502,
  });

export const getRepo = async (
  token: string,
  owner: string,
  name: string,
  { secretName = null, fetchImpl = fetch }: GitHubRepoAccessOptions = {},
): Promise<GitHubRepoAccess> => {
  const response = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    { headers: githubHeaders(token) },
  );
  if (response.status === 401) {
    throw githubCredentialRejectedError({ secretName });
  }
  if (response.status === 403 || response.status === 404) {
    throw githubRepoNotAccessibleError(owner, name);
  }
  if (!response.ok) {
    throw unexpectedStatusError(response.status, `${owner}/${name}`);
  }
  const body = (await response.json()) as RepoResponseBody;
  if (typeof body.id !== "number" || !body.full_name) {
    throw unexpectedStatusError(response.status, `${owner}/${name}`);
  }
  return {
    id: body.id,
    fullName: body.full_name,
    hasIssues: body.has_issues ?? true,
  };
};

export const getUser = async (
  token: string,
  { secretName = null, fetchImpl = fetch }: GitHubRepoAccessOptions = {},
): Promise<GitHubTokenUser> => {
  const response = await fetchImpl("https://api.github.com/user", {
    headers: githubHeaders(token),
  });
  if (response.status === 401) {
    throw githubCredentialRejectedError({ secretName });
  }
  if (!response.ok) {
    throw unexpectedStatusError(response.status, "the token's account");
  }
  const body = (await response.json()) as UserResponseBody;
  if (!body.login) {
    throw unexpectedStatusError(response.status, "the token's account");
  }
  return { login: body.login };
};
