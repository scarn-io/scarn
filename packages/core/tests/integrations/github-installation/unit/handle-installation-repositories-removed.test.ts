import { describe, expect, test } from "bun:test";
import { handleInstallationRepositoriesRemoved } from "@/integrations/github-installation/application/handle-installation-repositories-removed";
import type { GitHubInstallationRepo } from "@/integrations/github-installation/application/github-installation-repo";
import type { ProjectIntegrationRepo } from "@/integrations/project-integration/application/project-integration-repo";
import { GitHubInstallationEntity } from "@/integrations/github-installation/domain/github-installation-entity";
import {
  GitHubAppProjectIntegration,
  isGitHubAppIntegration,
  type ProjectIntegrationEntity,
} from "@/integrations/project-integration/domain/project-integration-entity";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f01");

const makeIntegration = (
  idSeed: string,
  repos: { id: number; fullName: string }[],
): GitHubAppProjectIntegration =>
  GitHubAppProjectIntegration.create({
    id: parseUuidV7(idSeed),
    projectId,
    installationId: "555",
    scope: { repos },
  });

const makeRepos = (
  installation: GitHubInstallationEntity | null,
  integrations: ProjectIntegrationEntity[],
) => {
  const githubRepo: GitHubInstallationRepo = {
    findByInstallationId(id) {
      return Promise.resolve(
        installation?.installationId === id ? installation : null,
      );
    },
    findByInstalledByUserId(userId) {
      return Promise.resolve(
        installation?.installedByUserId === userId ? [installation] : [],
      );
    },
    upsert(entity) {
      installation = entity;
      return Promise.resolve(entity);
    },
    deleteByInstallationId() {
      return Promise.resolve(1);
    },
  };

  const stored = new Map(integrations.map((entry) => [entry.id, entry]));
  const projectIntegrationRepo: ProjectIntegrationRepo = {
    create(entity) {
      stored.set(entity.id, entity);
      return Promise.resolve(entity);
    },
    save(entity) {
      stored.set(entity.id, entity);
      return Promise.resolve(entity);
    },
    findById(id) {
      return Promise.resolve(stored.get(id) ?? null);
    },
    listByProjectId() {
      return Promise.resolve([...stored.values()]);
    },
    findByInstallationId(installationId) {
      return Promise.resolve(
        [...stored.values()]
          .filter(isGitHubAppIntegration)
          .filter((entry) => entry.installationId === installationId),
      );
    },
    listActive() {
      return Promise.resolve(
        [...stored.values()].filter(
          (entry) => entry.status === "active" || entry.status === "error",
        ),
      );
    },
    delete(id) {
      const removed = stored.delete(id) ? 1 : 0;
      return Promise.resolve(removed);
    },
    deleteByInstallationId(installationId) {
      let removed = 0;
      for (const [id, entry] of stored) {
        if (
          isGitHubAppIntegration(entry) &&
          entry.installationId === installationId
        ) {
          stored.delete(id);
          removed += 1;
        }
      }
      return Promise.resolve(removed);
    },
  };

  return { githubRepo, projectIntegrationRepo, stored };
};

const buildInstallation = (
  selected: { id: number; fullName: string }[],
): GitHubInstallationEntity =>
  GitHubInstallationEntity.create({
    installationId: "555",
    accountLogin: "acme",
    accountType: "Organization",
    targetType: "selected",
    selectedRepositories: selected,
  });

describe("handleInstallationRepositoriesRemoved", () => {
  test("trims removed repos from each affected project integration", async () => {
    const integration = makeIntegration(
      "0196917c-532c-75aa-b7d5-0a84b71a1f10",
      [
        { id: 1, fullName: "acme/alpha" },
        { id: 2, fullName: "acme/beta" },
      ],
    );
    const installation = buildInstallation([
      { id: 1, fullName: "acme/alpha" },
      { id: 2, fullName: "acme/beta" },
    ]);
    const { githubRepo, projectIntegrationRepo, stored } = makeRepos(
      installation,
      [integration],
    );

    const result = await handleInstallationRepositoriesRemoved(
      { installationId: "555", removedRepositoryIds: [1] },
      { githubInstallationRepo: githubRepo, projectIntegrationRepo },
    );

    expect(result.projectIntegrationsUpdated).toBe(1);
    expect(result.projectIntegrationsDeleted).toBe(0);
    const updated = stored.get(integration.id);
    expect(updated?.scope).toEqual({
      repos: [{ id: 2, fullName: "acme/beta" }],
    });
  });

  test("deletes the integration when all its repos are removed", async () => {
    const integration = makeIntegration(
      "0196917c-532c-75aa-b7d5-0a84b71a1f11",
      [{ id: 3, fullName: "acme/gamma" }],
    );
    const installation = buildInstallation([{ id: 3, fullName: "acme/gamma" }]);
    const { githubRepo, projectIntegrationRepo, stored } = makeRepos(
      installation,
      [integration],
    );

    const result = await handleInstallationRepositoriesRemoved(
      { installationId: "555", removedRepositoryIds: [3] },
      { githubInstallationRepo: githubRepo, projectIntegrationRepo },
    );

    expect(result.projectIntegrationsUpdated).toBe(0);
    expect(result.projectIntegrationsDeleted).toBe(1);
    expect(stored.has(integration.id)).toBe(false);
  });

  test("ignores integrations whose repos do not include the removed ids", async () => {
    const integration = makeIntegration(
      "0196917c-532c-75aa-b7d5-0a84b71a1f12",
      [{ id: 4, fullName: "acme/delta" }],
    );
    const installation = buildInstallation([{ id: 4, fullName: "acme/delta" }]);
    const { githubRepo, projectIntegrationRepo } = makeRepos(installation, [
      integration,
    ]);

    const result = await handleInstallationRepositoriesRemoved(
      { installationId: "555", removedRepositoryIds: [99] },
      { githubInstallationRepo: githubRepo, projectIntegrationRepo },
    );

    expect(result.projectIntegrationsUpdated).toBe(0);
    expect(result.projectIntegrationsDeleted).toBe(0);
  });
});
