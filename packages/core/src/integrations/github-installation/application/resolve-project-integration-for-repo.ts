import type { GitHubAppProjectIntegration } from "../../project-integration/domain/project-integration-entity";
import type { ProjectIntegrationRepo } from "../../project-integration/application/project-integration-repo";

/**
 * Resolves a webhook's `(installation.id, repository.id)` to the single
 * `project_integrations` row that scope includes that repo (decision 11,
 * docs/plans/github-integration-sync-scaling.md).
 *
 * `findByInstallationId` is indexed on `installation_id` but returns every
 * `github_app` integration for that installation; narrowing to one repo
 * happens by filtering the (unindexed) `scope.repos` array in application code —
 * the exact pattern `handleInstallationRepositoriesRemoved` already uses.
 * Installations map to a small number of project integrations today, so this
 * in-memory filter is not a hot-path scaling risk.
 *
 * Returns `null` when no integration's scope includes the repo (e.g. the
 * installation exists but was never linked to a project, or the repo was
 * since removed from every integration's scope) — callers should treat that
 * as "nothing to do", not an error.
 */
export const resolveProjectIntegrationForRepo = async (
  input: { installationId: string; repositoryId: number },
  deps: { projectIntegrationRepo: ProjectIntegrationRepo },
): Promise<GitHubAppProjectIntegration | null> => {
  const candidates = await deps.projectIntegrationRepo.findByInstallationId(
    input.installationId,
  );

  return (
    candidates.find((integration) =>
      integration.scope.repos.some((repo) => repo.id === input.repositoryId),
    ) ?? null
  );
};
