import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { GitHubInstallationRepository } from "../domain/github-installation-entity";
import type { GitHubInstallationRepo } from "./github-installation-repo";

export type ListMyGitHubReposInput = {
  userId: UuidV7;
};

export type MyGitHubInstallationRepos = {
  installationId: string;
  accountLogin: string | null;
  repos: GitHubInstallationRepository[];
};

/**
 * Read-only: returns the cached repo list for every installation the given
 * user owns. Never calls the GitHub API — the picker's default view is served
 * entirely from `selectedRepositories` as persisted at install/refresh time.
 * See `refreshGitHubInstallationRepos` (route: `POST
 * /integrations/github/installations/:installationId/refresh`) for the one
 * place a live fetch happens on this surface.
 */
export const listMyGitHubRepos = async (
  input: ListMyGitHubReposInput,
  deps: { githubInstallationRepo: GitHubInstallationRepo },
): Promise<MyGitHubInstallationRepos[]> => {
  const installations =
    await deps.githubInstallationRepo.findByInstalledByUserId(input.userId);

  return installations.map((installation) => ({
    installationId: installation.installationId,
    accountLogin: installation.accountLogin,
    repos: installation.selectedRepositories ?? [],
  }));
};
