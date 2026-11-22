import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { CoreError } from "@scarn/core/lib/errors";
import type {
  GitHubInstallationEntity,
  GitHubInstallationRepository,
} from "../domain/github-installation-entity";
import type { GitHubInstallationRepo } from "./github-installation-repo";

export type CoveringGitHubInstallation = {
  installationId: string;
  accountLogin: string | null;
  repo: GitHubInstallationRepository;
};

export type GitHubRepoRef = { owner: string; name: string };

/**
 * Asks GitHub, as one installation, which repo `owner/name` is now. GitHub
 * follows renames and transfers, so this returns the stable id even for an
 * old name. Null when the installation can't see it.
 */
export type ResolveInstallationRepo = (input: {
  installationId: string;
  owner: string;
  name: string;
}) => Promise<GitHubInstallationRepository | null>;

export type FindCoveringGitHubInstallationDeps = {
  githubInstallationRepo: GitHubInstallationRepo;
  /** Absent when the GitHub App isn't configured: matching is by name only. */
  resolveInstallationRepo?: ResolveInstallationRepo | undefined;
};

const findByName = (
  repos: GitHubInstallationRepository[],
  ref: GitHubRepoRef,
): GitHubInstallationRepository | undefined => {
  const wanted = `${ref.owner}/${ref.name}`.toLowerCase();
  return repos.find((repo) => repo.fullName.toLowerCase() === wanted);
};

/**
 * The installation's cached repo for `ref`: by name first, then — for a URL
 * that uses a renamed or transferred repo's old name — by the id GitHub
 * resolves the name to. Matching the id against the cached list matters: an
 * installation token can read any public repo, not only the ones it covers.
 */
const findCoveredRepo = async (
  installation: GitHubInstallationEntity,
  ref: GitHubRepoRef,
  deps: FindCoveringGitHubInstallationDeps,
): Promise<GitHubInstallationRepository | undefined> => {
  const repos = installation.selectedRepositories ?? [];
  const byName = findByName(repos, ref);
  if (byName || repos.length === 0 || !deps.resolveInstallationRepo) {
    return byName;
  }
  const resolved = await deps.resolveInstallationRepo({
    installationId: installation.installationId,
    ...ref,
  });
  if (!resolved || !repos.some((repo) => repo.id === resolved.id)) {
    return undefined;
  }
  return resolved;
};

/**
 * The first of the user's GitHub App installations that covers `ref`, or null
 * when none does. An installation GitHub can't be asked about is skipped.
 */
export const findCoveringGitHubInstallation = async (
  input: { userId: UuidV7 } & GitHubRepoRef,
  deps: FindCoveringGitHubInstallationDeps,
): Promise<CoveringGitHubInstallation | null> => {
  const installations =
    await deps.githubInstallationRepo.findByInstalledByUserId(input.userId);
  for (const installation of installations) {
    const repo = await findCoveredRepo(installation, input, deps).catch(
      () => undefined,
    );
    if (repo) {
      return {
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        repo,
      };
    }
  }
  return null;
};

/**
 * The repo `ref` as seen by one installation the user owns. The same 403
 * whether the installation doesn't exist or belongs to someone else, so
 * installation ids are never revealed.
 */
export const requireOwnedInstallationRepo = async (
  input: { userId: UuidV7; installationId: string } & GitHubRepoRef,
  deps: FindCoveringGitHubInstallationDeps,
): Promise<GitHubInstallationRepository> => {
  const installation = await deps.githubInstallationRepo.findByInstallationId(
    input.installationId,
  );
  if (!installation || installation.installedByUserId !== input.userId) {
    throw new CoreError({
      code: "GITHUB_INSTALLATION_NOT_OWNED",
      message: "This GitHub installation does not belong to you",
      status: 403,
    });
  }
  const repo = await findCoveredRepo(installation, input, deps);
  if (!repo) {
    throw new CoreError({
      code: "GITHUB_INSTALLATION_REPO_NOT_COVERED",
      message: `The GitHub App installation can't see ${input.owner}/${input.name}. Add the repository to the installation, then refresh its repo list.`,
      status: 422,
    });
  }
  return repo;
};
