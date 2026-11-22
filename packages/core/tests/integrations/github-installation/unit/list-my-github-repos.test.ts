import { describe, expect, test } from "bun:test";
import { listMyGitHubRepos } from "@/integrations/github-installation/application/list-my-github-repos";
import type { GitHubInstallationRepo } from "@/integrations/github-installation/application/github-installation-repo";
import { GitHubInstallationEntity } from "@/integrations/github-installation/domain/github-installation-entity";
import { createUuidV7 } from "@/common/contracts/uuid-v7";

const makeRepo = (
  installations: GitHubInstallationEntity[],
): GitHubInstallationRepo => ({
  findByInstallationId(installationId) {
    return Promise.resolve(
      installations.find((i) => i.installationId === installationId) ?? null,
    );
  },
  findByInstalledByUserId(userId) {
    return Promise.resolve(
      installations.filter((i) => i.installedByUserId === userId),
    );
  },
  upsert(entity) {
    return Promise.resolve(entity);
  },
  deleteByInstallationId() {
    return Promise.resolve(0);
  },
});

describe("listMyGitHubRepos", () => {
  test("returns the cached repo list for every installation the user owns", async () => {
    const userId = createUuidV7();
    const installationA = GitHubInstallationEntity.create({
      installationId: "1001",
      accountLogin: "connorivy",
      accountType: "User",
      targetType: "selected",
      selectedRepositories: [{ id: 1, fullName: "scarn-io/scarn" }],
      installedByUserId: userId,
    });
    const installationB = GitHubInstallationEntity.create({
      installationId: "1002",
      accountLogin: "take-command-org",
      accountType: "Organization",
      targetType: "all",
      selectedRepositories: [
        { id: 2, fullName: "take-command-org/voc-viewer" },
        { id: 3, fullName: "take-command-org/scarn" },
      ],
      installedByUserId: userId,
    });
    const someoneElsesInstallation = GitHubInstallationEntity.create({
      installationId: "1003",
      accountLogin: "not-me",
      accountType: "User",
      targetType: "all",
      selectedRepositories: [{ id: 4, fullName: "not-me/private-repo" }],
      installedByUserId: createUuidV7(),
    });
    const repo = makeRepo([
      installationA,
      installationB,
      someoneElsesInstallation,
    ]);

    const result = await listMyGitHubRepos(
      { userId },
      { githubInstallationRepo: repo },
    );

    expect(result).toEqual([
      {
        installationId: "1001",
        accountLogin: "connorivy",
        repos: [{ id: 1, fullName: "scarn-io/scarn" }],
      },
      {
        installationId: "1002",
        accountLogin: "take-command-org",
        repos: [
          { id: 2, fullName: "take-command-org/voc-viewer" },
          { id: 3, fullName: "take-command-org/scarn" },
        ],
      },
    ]);
  });

  test("returns an empty array when the user owns no installations", async () => {
    const userId = createUuidV7();
    const repo = makeRepo([]);

    const result = await listMyGitHubRepos(
      { userId },
      { githubInstallationRepo: repo },
    );

    expect(result).toEqual([]);
  });

  test("returns an empty repos list (not an error) for an installation with zero selected repos", async () => {
    const userId = createUuidV7();
    const installation = GitHubInstallationEntity.create({
      installationId: "1004",
      accountLogin: "connorivy",
      accountType: "User",
      targetType: "selected",
      selectedRepositories: null,
      installedByUserId: userId,
    });
    const repo = makeRepo([installation]);

    const result = await listMyGitHubRepos(
      { userId },
      { githubInstallationRepo: repo },
    );

    expect(result).toEqual([
      { installationId: "1004", accountLogin: "connorivy", repos: [] },
    ]);
  });
});
