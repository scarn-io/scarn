import { CoreError } from "@scarn/core/lib/errors";
import type { ResolveInstallationRepo } from "../application/find-covering-github-installation";
import type { GitHubInstallationRepository } from "../domain/github-installation-entity";
import {
  GitHubInstallationTokenError,
  mintGitHubInstallationToken,
} from "./mint-installation-token";

export type FetchInstallationRepoInput = {
  appId: string;
  privateKey: string;
  installationId: string;
  owner: string;
  name: string;
  fetchImpl?: typeof fetch;
};

type RepoResponseBody = {
  id?: number;
  full_name?: string;
};

const requestFailedError = (status: number, what: string): CoreError =>
  new CoreError({
    code: "GITHUB_REQUEST_FAILED",
    message: `GitHub returned ${String(status)} while reading ${what}`,
    status: 502,
  });

/**
 * `GET /repos/{owner}/{name}` with an installation token. GitHub follows
 * renames and transfers, so an old `owner/name` still resolves to the repo's
 * stable id and current name. Null when the installation can't see it (or no
 * longer exists).
 */
export const fetchInstallationRepo = async ({
  appId,
  privateKey,
  installationId,
  owner,
  name,
  fetchImpl = fetch,
}: FetchInstallationRepoInput): Promise<GitHubInstallationRepository | null> => {
  let token: string;
  try {
    ({ token } = await mintGitHubInstallationToken({
      appId,
      privateKey,
      installationId,
      fetchImpl,
    }));
  } catch (error: unknown) {
    if (error instanceof GitHubInstallationTokenError && error.status === 404) {
      return null;
    }
    throw error;
  }

  const response = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "scarn",
      },
    },
  );
  if (response.status === 403 || response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw requestFailedError(response.status, `${owner}/${name}`);
  }
  const body = (await response.json()) as RepoResponseBody;
  if (typeof body.id !== "number" || !body.full_name) {
    throw requestFailedError(response.status, `${owner}/${name}`);
  }
  return { id: body.id, fullName: body.full_name };
};

/** A {@link ResolveInstallationRepo} for the configured App; undefined without a private key. */
export const installationRepoResolver = (
  githubApp: { appId: string; privateKey: string | null } | null,
): ResolveInstallationRepo | undefined => {
  if (!githubApp?.privateKey) return undefined;
  const { appId, privateKey } = githubApp;
  return (input) => fetchInstallationRepo({ appId, privateKey, ...input });
};
