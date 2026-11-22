import { signGitHubAppJwt } from "./github-app-jwt";
import { mintGitHubInstallationToken } from "./mint-installation-token";

export type FetchInstallationMetadataInput = {
  appId: string;
  privateKey: string;
  installationId: string;
  now?: Date;
  fetchImpl?: typeof fetch;
};

export type InstallationMetadata = {
  accountLogin: string | null;
  accountType: "User" | "Organization" | null;
  targetType: "all" | "selected" | null;
  repositories: { id: number; fullName: string }[];
};

export class GitHubInstallationMetadataError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GitHubInstallationMetadataError";
  }
}

type InstallationApi = {
  account?: { login?: string; type?: string };
  repository_selection?: string;
};

type RepositoriesApi = {
  repositories?: { id?: number; full_name?: string }[];
};

const githubHeaders = (token: string) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "x-github-api-version": "2022-11-28",
  "user-agent": "scarn",
});

const REPOSITORIES_PER_PAGE = 100;

/**
 * `/installation/repositories` is paginated. Loop with `page=`/`per_page=`
 * until a short page (fewer than `per_page` results) confirms there is no
 * further page, accumulating repositories across all pages.
 */
const fetchAllInstallationRepositories = async ({
  token,
  installationId,
  fetchImpl,
}: {
  token: string;
  installationId: string;
  fetchImpl: typeof fetch;
}): Promise<{ id: number; fullName: string }[]> => {
  const repositories: { id: number; fullName: string }[] = [];

  for (let page = 1; ; page += 1) {
    const reposRes = await fetchImpl(
      `https://api.github.com/installation/repositories?per_page=${String(REPOSITORIES_PER_PAGE)}&page=${String(page)}`,
      { headers: githubHeaders(token) },
    );
    if (!reposRes.ok) {
      throw new GitHubInstallationMetadataError(
        `GitHub returned ${String(reposRes.status)} while listing repositories for installation ${installationId}`,
        reposRes.status,
      );
    }
    const body = (await reposRes.json()) as RepositoriesApi;
    const pageRepositories = body.repositories ?? [];
    const parsed = pageRepositories.filter(
      (entry): entry is { id: number; full_name: string } =>
        typeof entry.id === "number" && typeof entry.full_name === "string",
    );
    repositories.push(
      ...parsed.map((entry) => ({ id: entry.id, fullName: entry.full_name })),
    );

    if (pageRepositories.length < REPOSITORIES_PER_PAGE) {
      break;
    }
  }

  return repositories;
};

const parseAccountType = (
  value: string | undefined,
): "User" | "Organization" | null =>
  value === "User" || value === "Organization" ? value : null;

const parseTargetType = (
  value: string | undefined,
): "all" | "selected" | null =>
  value === "all" || value === "selected" ? value : null;

export const fetchInstallationMetadata = async ({
  appId,
  privateKey,
  installationId,
  now = new Date(),
  fetchImpl = fetch,
}: FetchInstallationMetadataInput): Promise<InstallationMetadata> => {
  const jwt = signGitHubAppJwt({ appId, privateKey, now });

  const installRes = await fetchImpl(
    `https://api.github.com/app/installations/${installationId}`,
    { headers: githubHeaders(jwt) },
  );
  if (!installRes.ok) {
    throw new GitHubInstallationMetadataError(
      `GitHub returned ${String(installRes.status)} while loading installation ${installationId}`,
      installRes.status,
    );
  }
  const install = (await installRes.json()) as InstallationApi;
  const accountLogin = install.account?.login?.trim() || null;
  const accountType = parseAccountType(install.account?.type);
  const targetType = parseTargetType(install.repository_selection);

  const token = await mintGitHubInstallationToken({
    appId,
    privateKey,
    installationId,
    now,
    fetchImpl,
  });

  const repositories = await fetchAllInstallationRepositories({
    token: token.token,
    installationId,
    fetchImpl,
  });

  return { accountLogin, accountType, targetType, repositories };
};
