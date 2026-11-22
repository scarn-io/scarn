import { describe, expect, test } from "bun:test";
import { upsertGitHubInstallation } from "@/integrations/github-installation/application/upsert-github-installation";
import type { GitHubInstallationRepo } from "@/integrations/github-installation/application/github-installation-repo";
import {
  GitHubInstallationEntity,
  type GitHubInstallationEntityProps,
} from "@/integrations/github-installation/domain/github-installation-entity";
import { parseUuidV7, createUuidV7 } from "@/common/contracts/uuid-v7";

const makeFakeRepo = (
  initial: GitHubInstallationEntity | null = null,
): {
  repo: GitHubInstallationRepo;
  upsertCalls: GitHubInstallationEntity[];
} => {
  const upsertCalls: GitHubInstallationEntity[] = [];
  let stored = initial;

  const repo: GitHubInstallationRepo = {
    findByInstallationId(installationId) {
      return Promise.resolve(
        stored?.installationId === installationId ? stored : null,
      );
    },
    findByInstalledByUserId(userId) {
      return Promise.resolve(
        stored?.installedByUserId === userId ? [stored] : [],
      );
    },
    upsert(entity) {
      upsertCalls.push(entity);
      stored = entity;
      return Promise.resolve(entity);
    },
    deleteByInstallationId() {
      stored = null;
      return Promise.resolve(1);
    },
  };

  return { repo, upsertCalls };
};

describe("upsertGitHubInstallation", () => {
  test("creates a new installation when none exists", async () => {
    const { repo, upsertCalls } = makeFakeRepo();

    const { installation: result, created } = await upsertGitHubInstallation(
      {
        installationId: "9001",
        accountLogin: "connorivy",
        accountType: "User",
        targetType: "selected",
        selectedRepositories: [{ id: 1, fullName: "scarn-io/scarn" }],
      },
      repo,
    );

    expect(result.installationId).toBe("9001");
    expect(result.accountLogin).toBe("connorivy");
    expect(result.targetType).toBe("selected");
    expect(created).toBe(true);
    expect(upsertCalls).toHaveLength(1);
  });

  test("updates metadata on an existing installation", async () => {
    const existingProps: GitHubInstallationEntityProps = {
      id: parseUuidV7("0196917d-cb83-7c5e-9e87-cf32f4c0e6cd"),
      installationId: "9001",
      accountLogin: "connorivy",
      accountType: "User",
      targetType: "selected",
      selectedRepositories: [{ id: 1, fullName: "scarn-io/scarn" }],
      createdAt: new Date("2026-05-01T00:00:00Z"),
      updatedAt: new Date("2026-05-01T00:00:00Z"),
    };
    const existing = GitHubInstallationEntity.rehydrate(existingProps);
    const { repo, upsertCalls } = makeFakeRepo(existing);

    const { installation: result, created } = await upsertGitHubInstallation(
      {
        installationId: "9001",
        accountLogin: "connorivy",
        accountType: "User",
        targetType: "all",
        selectedRepositories: null,
      },
      repo,
    );

    expect(result.id).toBe(existing.id);
    expect(result.targetType).toBe("all");
    expect(result.selectedRepositories).toBeNull();
    expect(created).toBe(false);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]?.id).toBe(existing.id);
  });

  test("sets installedByUserId when creating a new installation", async () => {
    const { repo } = makeFakeRepo();
    const userId = createUuidV7();

    const { installation: result } = await upsertGitHubInstallation(
      {
        installationId: "9002",
        accountLogin: "connorivy",
        accountType: "User",
        targetType: "all",
        selectedRepositories: null,
        installedByUserId: userId,
      },
      repo,
    );

    expect(result.installedByUserId).toBe(userId);
  });

  test("defaults installedByUserId to null when creating without one", async () => {
    const { repo } = makeFakeRepo();

    const { installation: result } = await upsertGitHubInstallation(
      {
        installationId: "9003",
        accountLogin: "connorivy",
        accountType: "User",
        targetType: "all",
        selectedRepositories: null,
      },
      repo,
    );

    expect(result.installedByUserId).toBeNull();
  });

  test("preserves the existing owner when updating without installedByUserId", async () => {
    const userId = createUuidV7();
    const existing = GitHubInstallationEntity.create({
      installationId: "9004",
      accountLogin: "connorivy",
      accountType: "User",
      targetType: "selected",
      selectedRepositories: [{ id: 1, fullName: "scarn-io/scarn" }],
      installedByUserId: userId,
    });
    const { repo } = makeFakeRepo(existing);

    const { installation: result } = await upsertGitHubInstallation(
      {
        installationId: "9004",
        accountLogin: "connorivy",
        accountType: "User",
        targetType: "all",
        selectedRepositories: null,
      },
      repo,
    );

    expect(result.installedByUserId).toBe(userId);
  });

  test("re-attributes the owner when a new installedByUserId is provided", async () => {
    const originalOwner = createUuidV7();
    const newOwner = createUuidV7();
    const existing = GitHubInstallationEntity.create({
      installationId: "9005",
      accountLogin: "connorivy",
      accountType: "User",
      targetType: "selected",
      selectedRepositories: [{ id: 1, fullName: "scarn-io/scarn" }],
      installedByUserId: originalOwner,
    });
    const { repo } = makeFakeRepo(existing);

    const { installation: result } = await upsertGitHubInstallation(
      {
        installationId: "9005",
        accountLogin: "connorivy",
        accountType: "User",
        targetType: "selected",
        selectedRepositories: [{ id: 1, fullName: "scarn-io/scarn" }],
        installedByUserId: newOwner,
      },
      repo,
    );

    expect(result.installedByUserId).toBe(newOwner);
  });

  test("findByInstalledByUserId returns installations owned by that user", async () => {
    const userId = createUuidV7();
    const existing = GitHubInstallationEntity.create({
      installationId: "9006",
      accountLogin: "connorivy",
      accountType: "User",
      targetType: "all",
      selectedRepositories: null,
      installedByUserId: userId,
    });
    const { repo } = makeFakeRepo(existing);

    const found = await repo.findByInstalledByUserId(userId);
    expect(found).toHaveLength(1);
    expect(found[0]?.installationId).toBe("9006");

    const notFound = await repo.findByInstalledByUserId(createUuidV7());
    expect(notFound).toHaveLength(0);
  });
});
