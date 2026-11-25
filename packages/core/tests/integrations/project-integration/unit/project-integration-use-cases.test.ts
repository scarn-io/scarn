import { describe, expect, test } from "bun:test";
import { createProjectIntegration } from "@/integrations/project-integration/application/create-project-integration";
import { updateProjectIntegrationScope } from "@/integrations/project-integration/application/update-project-integration-scope";
import { deleteProjectIntegration } from "@/integrations/project-integration/application/delete-project-integration";
import { markProjectIntegrationSynced } from "@/integrations/project-integration/application/mark-project-integration-synced";
import type { ProjectIntegrationRepo } from "@/integrations/project-integration/application/project-integration-repo";
import {
  GitHubAppProjectIntegration,
  isGitHubAppIntegration,
  type GitHubProjectIntegrationScope,
  type ProjectIntegrationEntity,
} from "@/integrations/project-integration/domain/project-integration-entity";
import { parseUuidV7, createUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError } from "@/lib/errors";

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f02");
const otherProjectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f03");
const scope = (
  repos: Array<{ id: number; fullName: string }>,
): GitHubProjectIntegrationScope => ({ repos });

const makeFakeRepo = (): {
  repo: ProjectIntegrationRepo;
  stored: Map<string, ProjectIntegrationEntity>;
} => {
  const stored = new Map<string, ProjectIntegrationEntity>();

  const repo: ProjectIntegrationRepo = {
    create(integration) {
      stored.set(integration.id, integration);
      return Promise.resolve(integration);
    },
    save(integration) {
      stored.set(integration.id, integration);
      return Promise.resolve(integration);
    },
    findById(id) {
      return Promise.resolve(stored.get(id) ?? null);
    },
    listByProjectId(targetProjectId) {
      return Promise.resolve(
        Array.from(stored.values()).filter(
          (entry) => entry.projectId === targetProjectId,
        ),
      );
    },
    findByInstallationId(installationId) {
      return Promise.resolve(
        Array.from(stored.values())
          .filter(isGitHubAppIntegration)
          .filter((entry) => entry.installationId === installationId),
      );
    },
    listActive() {
      return Promise.resolve(
        Array.from(stored.values()).filter(
          (entry) => entry.status === "active" || entry.status === "error",
        ),
      );
    },
    delete(id, targetProjectId) {
      const existing = stored.get(id);
      if (existing && existing.projectId === targetProjectId) {
        stored.delete(id);
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
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

  return { repo, stored };
};

describe("project integration use cases", () => {
  test("create persists a new integration", async () => {
    const { repo, stored } = makeFakeRepo();

    const created = await createProjectIntegration(
      {
        projectId,
        kind: "github_app",
        installationId: "12345",
        externalScope: scope([{ id: 1, fullName: "scarn-io/scarn" }]),
      },
      repo,
    );

    expect(created.kind).toBe("github_app");
    expect(created.platform).toBe("github");
    if (created.kind !== "github_app") throw new Error("expected github_app");
    expect(created.installationId).toBe("12345");
    expect(created.scope.repos).toHaveLength(1);
    expect(stored.size).toBe(1);
  });

  test("create rejects a duplicate (project + kind + installation)", async () => {
    const { repo } = makeFakeRepo();

    await createProjectIntegration(
      {
        projectId,
        kind: "github_app",
        installationId: "12345",
        externalScope: scope([{ id: 1, fullName: "scarn-io/scarn" }]),
      },
      repo,
    );

    let error: unknown = null;
    try {
      await createProjectIntegration(
        {
          projectId,
          kind: "github_app",
          installationId: "12345",
          externalScope: scope([{ id: 2, fullName: "connorivy/other" }]),
        },
        repo,
      );
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CoreValidationError);
  });

  test("create allows the same installation on a different project", async () => {
    const { repo, stored } = makeFakeRepo();

    await createProjectIntegration(
      {
        projectId,
        kind: "github_app",
        installationId: "12345",
        externalScope: scope([{ id: 1, fullName: "scarn-io/scarn" }]),
      },
      repo,
    );
    await createProjectIntegration(
      {
        projectId: otherProjectId,
        kind: "github_app",
        installationId: "12345",
        externalScope: scope([{ id: 1, fullName: "scarn-io/scarn" }]),
      },
      repo,
    );

    expect(stored.size).toBe(2);
  });

  test("create rejects an empty repository scope", async () => {
    const { repo } = makeFakeRepo();
    let error: unknown = null;
    try {
      await createProjectIntegration(
        {
          projectId,
          kind: "github_app",
          installationId: "12345",
          externalScope: { repos: [] },
        },
        repo,
      );
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CoreValidationError);
  });

  test("updateScope replaces the repo list", async () => {
    const { repo } = makeFakeRepo();
    const created = await createProjectIntegration(
      {
        projectId,
        kind: "github_app",
        installationId: "12345",
        externalScope: scope([{ id: 1, fullName: "a/b" }]),
      },
      repo,
    );

    const updated = await updateProjectIntegrationScope(
      {
        id: created.id,
        projectId,
        kind: "github_app",
        externalScope: scope([
          { id: 1, fullName: "a/b" },
          { id: 2, fullName: "a/c" },
        ]),
      },
      repo,
    );

    if (updated.kind !== "github_app") throw new Error("expected github_app");
    expect(updated.scope.repos.map((r) => r.fullName)).toEqual(["a/b", "a/c"]);
  });

  test("updateScope rejects when the project doesn't own the integration", async () => {
    const { repo } = makeFakeRepo();
    const created = await createProjectIntegration(
      {
        projectId,
        kind: "github_app",
        installationId: "12345",
        externalScope: scope([{ id: 1, fullName: "a/b" }]),
      },
      repo,
    );

    let error: unknown = null;
    try {
      await updateProjectIntegrationScope(
        {
          id: created.id,
          projectId: otherProjectId,
          kind: "github_app",
          externalScope: scope([{ id: 1, fullName: "a/b" }]),
        },
        repo,
      );
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CoreValidationError);
  });

  test("delete removes the integration only when project matches", async () => {
    const { repo, stored } = makeFakeRepo();
    const created = await createProjectIntegration(
      {
        projectId,
        kind: "github_app",
        installationId: "12345",
        externalScope: scope([{ id: 1, fullName: "a/b" }]),
      },
      repo,
    );

    expect(
      await deleteProjectIntegration(created.id, otherProjectId, repo),
    ).toBe(0);
    expect(stored.size).toBe(1);

    expect(await deleteProjectIntegration(created.id, projectId, repo)).toBe(1);
    expect(stored.size).toBe(0);
  });

  test("markProjectIntegrationSynced clears the error and sets lastSyncedAt", async () => {
    const { repo } = makeFakeRepo();
    const created = await createProjectIntegration(
      {
        projectId,
        kind: "github_app",
        installationId: "12345",
        externalScope: scope([{ id: 1, fullName: "a/b" }]),
      },
      repo,
    );

    const syncedAt = new Date("2026-05-24T12:00:00Z");
    const updated = await markProjectIntegrationSynced(
      created.id,
      syncedAt,
      repo,
    );

    expect(updated.status).toBe("active");
    expect(updated.lastError).toBeNull();
    expect(updated.lastSyncedAt?.toISOString()).toBe(syncedAt.toISOString());
  });

  test("listActive returns active and error integrations, excludes paused", async () => {
    const { repo, stored } = makeFakeRepo();

    const active = await createProjectIntegration(
      {
        projectId,
        kind: "github_app",
        installationId: "active-install",
        externalScope: scope([{ id: 1, fullName: "a/active" }]),
      },
      repo,
    );

    const erroring = await createProjectIntegration(
      {
        projectId,
        kind: "github_app",
        installationId: "error-install",
        externalScope: scope([{ id: 2, fullName: "a/error" }]),
      },
      repo,
    );
    const errored = erroring.withSyncError(
      "Bad credentials",
      new Date("2026-05-24T12:00:00Z"),
    );
    stored.set(errored.id, errored);

    const paused = GitHubAppProjectIntegration.rehydrate({
      id: createUuidV7(),
      projectId,
      installationId: "paused-install",
      scope: scope([{ id: 3, fullName: "a/paused" }]),
      status: "paused",
      lastSyncedAt: null,
      lastError: null,
      firstSyncHorizonDays: null,
    });
    stored.set(paused.id, paused);

    const results = await repo.listActive();
    const resultIds = results.map((entry) => entry.id).sort();

    expect(resultIds).toEqual([active.id, errored.id].sort());
    expect(results.some((entry) => entry.id === paused.id)).toBe(false);
  });
});
