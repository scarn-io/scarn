import type { GitHubInstallationRepo } from "./github-installation-repo";
import type { ProjectIntegrationRepo } from "../../project-integration/application/project-integration-repo";

export type HandleInstallationDeletedResult = {
  installationsDeleted: number;
  projectIntegrationsDeleted: number;
};

export const handleInstallationDeleted = async (
  installationId: string,
  deps: {
    githubInstallationRepo: GitHubInstallationRepo;
    projectIntegrationRepo: ProjectIntegrationRepo;
  },
): Promise<HandleInstallationDeletedResult> => {
  const projectIntegrationsDeleted =
    await deps.projectIntegrationRepo.deleteByInstallationId(installationId);
  const installationsDeleted =
    await deps.githubInstallationRepo.deleteByInstallationId(installationId);

  return { installationsDeleted, projectIntegrationsDeleted };
};
