import type { GitHubInstallationRepo } from "./github-installation-repo";
import { upsertGitHubInstallation } from "./upsert-github-installation";
import type { ProjectIntegrationRepo } from "../../project-integration/application/project-integration-repo";

export type HandleInstallationRepositoriesRemovedResult = {
  projectIntegrationsUpdated: number;
  projectIntegrationsDeleted: number;
};

export const handleInstallationRepositoriesRemoved = async (
  input: { installationId: string; removedRepositoryIds: number[] },
  deps: {
    githubInstallationRepo: GitHubInstallationRepo;
    projectIntegrationRepo: ProjectIntegrationRepo;
  },
): Promise<HandleInstallationRepositoriesRemovedResult> => {
  const removedIds = new Set(input.removedRepositoryIds);
  let updated = 0;
  let deleted = 0;

  const affected = await deps.projectIntegrationRepo.findByInstallationId(
    input.installationId,
  );

  for (const integration of affected) {
    const remaining = integration.scope.repos.filter(
      (repo) => !removedIds.has(repo.id),
    );
    if (remaining.length === integration.scope.repos.length) {
      continue;
    }
    if (remaining.length === 0) {
      await deps.projectIntegrationRepo.delete(
        integration.id,
        integration.projectId,
      );
      deleted += 1;
    } else {
      const next = integration.withRepos(remaining);
      await deps.projectIntegrationRepo.save(next);
      updated += 1;
    }
  }

  const existing = await deps.githubInstallationRepo.findByInstallationId(
    input.installationId,
  );
  if (existing) {
    const trimmedSelected = (existing.selectedRepositories ?? []).filter(
      (repo) => !removedIds.has(repo.id),
    );
    await upsertGitHubInstallation(
      {
        installationId: existing.installationId,
        accountLogin: existing.accountLogin,
        accountType: existing.accountType,
        targetType: existing.targetType,
        selectedRepositories: trimmedSelected,
      },
      deps.githubInstallationRepo,
    );
  }

  return {
    projectIntegrationsUpdated: updated,
    projectIntegrationsDeleted: deleted,
  };
};
