import { GitHubInstallationEntity } from "../domain/github-installation-entity";
import type { GitHubInstallationRepo } from "./github-installation-repo";

export type UpsertGitHubInstallationInput = {
  installationId: string;
  accountLogin: string | null;
  accountType: GitHubInstallationEntity["accountType"];
  targetType: GitHubInstallationEntity["targetType"];
  selectedRepositories: GitHubInstallationEntity["selectedRepositories"];
  // Omit to leave the current owner untouched (e.g. webhook-driven metadata
  // refreshes that have no user in context). Pass a `UuidV7` to attribute
  // (or re-attribute) the installation to a user.
  installedByUserId?: GitHubInstallationEntity["installedByUserId"] | undefined;
};

export type UpsertGitHubInstallationResult = {
  installation: GitHubInstallationEntity;
  /** True when this call recorded the installation for the first time. */
  created: boolean;
};

export const upsertGitHubInstallation = async (
  input: UpsertGitHubInstallationInput,
  repo: GitHubInstallationRepo,
): Promise<UpsertGitHubInstallationResult> => {
  const existing = await repo.findByInstallationId(input.installationId);
  const entity = existing
    ? existing.withMetadata({
        accountLogin: input.accountLogin,
        accountType: input.accountType,
        targetType: input.targetType,
        selectedRepositories: input.selectedRepositories,
        installedByUserId: input.installedByUserId,
      })
    : GitHubInstallationEntity.create({
        installationId: input.installationId,
        accountLogin: input.accountLogin,
        accountType: input.accountType,
        targetType: input.targetType,
        selectedRepositories: input.selectedRepositories,
        installedByUserId: input.installedByUserId ?? null,
      });

  return { installation: await repo.upsert(entity), created: !existing };
};
