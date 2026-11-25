import { describe, expect, test } from "bun:test";
import { handleInstallationDeleted } from "@/integrations/github-installation/application/handle-installation-deleted";
import type { GitHubInstallationRepo } from "@/integrations/github-installation/application/github-installation-repo";
import type { ProjectIntegrationRepo } from "@/integrations/project-integration/application/project-integration-repo";

const makeGithubRepo = (initialCount: number): GitHubInstallationRepo => {
  let count = initialCount;
  return {
    findByInstallationId() {
      return Promise.resolve(null);
    },
    findByInstalledByUserId() {
      return Promise.resolve([]);
    },
    upsert(entity) {
      return Promise.resolve(entity);
    },
    deleteByInstallationId() {
      const removed = count;
      count = 0;
      return Promise.resolve(removed);
    },
  };
};

const makeProjectIntegrationRepo = (
  initialCount: number,
): ProjectIntegrationRepo => {
  let count = initialCount;
  return {
    create(entity) {
      return Promise.resolve(entity);
    },
    save(entity) {
      return Promise.resolve(entity);
    },
    findById() {
      return Promise.resolve(null);
    },
    listByProjectId() {
      return Promise.resolve([]);
    },
    findByInstallationId() {
      return Promise.resolve([]);
    },
    listActive() {
      return Promise.resolve([]);
    },
    delete() {
      return Promise.resolve(1);
    },
    deleteByInstallationId() {
      const removed = count;
      count = 0;
      return Promise.resolve(removed);
    },
  };
};

describe("handleInstallationDeleted", () => {
  test("removes installation row + all project_integrations referencing it", async () => {
    const result = await handleInstallationDeleted("123", {
      githubInstallationRepo: makeGithubRepo(1),
      projectIntegrationRepo: makeProjectIntegrationRepo(3),
    });

    expect(result.installationsDeleted).toBe(1);
    expect(result.projectIntegrationsDeleted).toBe(3);
  });

  test("is idempotent — second call sees nothing to delete", async () => {
    const githubRepo = makeGithubRepo(0);
    const piRepo = makeProjectIntegrationRepo(0);

    const result = await handleInstallationDeleted("nonexistent", {
      githubInstallationRepo: githubRepo,
      projectIntegrationRepo: piRepo,
    });

    expect(result.installationsDeleted).toBe(0);
    expect(result.projectIntegrationsDeleted).toBe(0);
  });
});
