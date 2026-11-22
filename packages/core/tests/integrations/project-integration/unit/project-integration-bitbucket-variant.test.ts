import { describe, expect, test } from "bun:test";
import {
  BitbucketProjectIntegration,
  ProjectIntegrationEntity,
  isBitbucketIntegration,
  isGitHubIntegration,
  isUserCredentialIntegration,
  type ProjectIntegrationEntity as ProjectIntegrationEntityType,
} from "@/integrations/project-integration/domain/project-integration-entity";
import { createProjectIntegration } from "@/integrations/project-integration/application/create-project-integration";
import { updateProjectIntegrationScope } from "@/integrations/project-integration/application/update-project-integration-scope";
import type { ProjectIntegrationRepo } from "@/integrations/project-integration/application/project-integration-repo";
import { projectIntegrationEntityToContract } from "@/integrations/project-integration/application/project-integration-contract-mapper";
import { createUuidV7, parseUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError } from "@/lib/errors";
import type { AnyJsonObject } from "@/common/contracts/json";

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f02");
const REPO = { workspace: "team", slug: "api", fullName: "team/api" };

const bitbucket = (repos = [REPO]) =>
  BitbucketProjectIntegration.create({ projectId, scope: { repos } });

const errorCode = (fn: () => unknown): string | null => {
  try {
    fn();
  } catch (caught: unknown) {
    if (caught instanceof CoreValidationError) return caught.code;
    throw caught;
  }
  return null;
};

const asyncErrorCode = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (caught: unknown) {
    if (caught instanceof CoreValidationError) return caught.code;
    throw caught;
  }
  return null;
};

const unsupported = (): never => {
  throw new Error("not used by these tests");
};

const makeRepo = (): ProjectIntegrationRepo => {
  const stored = new Map<string, ProjectIntegrationEntityType>();
  return {
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
    listByProjectId(target) {
      return Promise.resolve(
        [...stored.values()].filter((entry) => entry.projectId === target),
      );
    },
    findByInstallationId: unsupported,
    listActive: unsupported,
    listDueForAutoSync: unsupported,
    listBySyncSecretId: unsupported,
    listBySyncSecretIds: unsupported,
    claimForSync: unsupported,
    releaseSyncClaim: unsupported,
    delete: unsupported,
    deleteByInstallationId: unsupported,
  };
};

const storedRow = (externalScopeJson: AnyJsonObject) => ({
  id: createUuidV7(),
  projectId,
  kind: "bitbucket" as const,
  installationId: null,
  externalScopeJson,
  status: "active" as const,
  lastSyncedAt: null,
  lastError: null,
  firstSyncHorizonDays: null,
  syncSecretId: null,
  autoSyncPausedReason: null,
  autoSyncPausedAt: null,
  autoSyncPausedDetail: null,
});

describe("BitbucketProjectIntegration", () => {
  test("is a Bitbucket integration read with a user's credential and has no installation", () => {
    const integration = bitbucket();

    expect(integration.kind).toBe("bitbucket");
    expect(integration.platform).toBe("bitbucket");
    expect(integration.authMode).toBe("user_credential");
    expect(integration.toJSON()).toMatchObject({
      kind: "bitbucket",
      installationId: null,
      externalScopeJson: { repos: [REPO] },
    });
  });

  test("needs at least one repo, each complete, with no duplicates by full name", () => {
    expect(errorCode(() => bitbucket([]))).toBe(
      "PROJECT_INTEGRATION_REPOS_REQUIRED",
    );
    expect(
      errorCode(() =>
        bitbucket([{ workspace: "team", slug: "", fullName: "team/" }]),
      ),
    ).toBe("PROJECT_INTEGRATION_REPO_INVALID");
    expect(
      errorCode(() =>
        bitbucket([
          REPO,
          { workspace: "Team", slug: "API", fullName: "Team/API" },
        ]),
      ),
    ).toBe("PROJECT_INTEGRATION_REPO_DUPLICATE");
  });

  test("withRepos keeps the variant", () => {
    const other = { workspace: "team", slug: "web", fullName: "team/web" };
    const next = bitbucket().withRepos([other]);

    expect(next).toBeInstanceOf(BitbucketProjectIntegration);
    expect(next.scope.repos).toEqual([other]);
  });

  test("the type guards sort it with user-credential integrations, not GitHub", () => {
    const integration = bitbucket();

    expect(isBitbucketIntegration(integration)).toBe(true);
    expect(isGitHubIntegration(integration)).toBe(false);
    expect(isUserCredentialIntegration(integration)).toBe(true);
  });

  test("create and rehydrate round-trip the repos", () => {
    const created = ProjectIntegrationEntity.create({
      kind: "bitbucket",
      projectId,
      scope: { repos: [REPO] },
    });
    const restored = ProjectIntegrationEntity.rehydrate(created.toJSON());

    expect(restored).toBeInstanceOf(BitbucketProjectIntegration);
    expect(restored.toJSON()).toEqual(created.toJSON());
    expect(
      projectIntegrationEntityToContract(restored, new Date()),
    ).toMatchObject({
      kind: "bitbucket",
      platform: "bitbucket",
      authMode: "user_credential",
      externalScope: { repos: [REPO] },
    });
  });

  test("rehydrate rejects an installation id or a GitHub-shaped scope", () => {
    expect(
      errorCode(() =>
        ProjectIntegrationEntity.rehydrate({
          ...storedRow({ repos: [REPO] }),
          installationId: "123",
        }),
      ),
    ).toBe("PROJECT_INTEGRATION_ROW_INVALID");
    expect(
      errorCode(() =>
        ProjectIntegrationEntity.rehydrate(
          storedRow({ repos: [{ id: 1, fullName: "team/api" }] }),
        ),
      ),
    ).toBe("PROJECT_INTEGRATION_ROW_INVALID");
  });
});

describe("Bitbucket createProjectIntegration duplicate rule", () => {
  test("rejects a second Bitbucket integration that shares a repo", async () => {
    const repo = makeRepo();
    await createProjectIntegration(
      { projectId, kind: "bitbucket", externalScope: { repos: [REPO] } },
      repo,
    );

    const code = await asyncErrorCode(() =>
      createProjectIntegration(
        {
          projectId,
          kind: "bitbucket",
          externalScope: {
            repos: [{ workspace: "Team", slug: "Api", fullName: "Team/Api" }],
          },
        },
        repo,
      ),
    );

    expect(code).toBe("PROJECT_INTEGRATION_DUPLICATE");
  });

  test("allows a different repo, and a GitHub token integration with the same full name", async () => {
    const repo = makeRepo();
    await createProjectIntegration(
      { projectId, kind: "bitbucket", externalScope: { repos: [REPO] } },
      repo,
    );

    const second = await createProjectIntegration(
      {
        projectId,
        kind: "bitbucket",
        externalScope: {
          repos: [{ workspace: "team", slug: "web", fullName: "team/web" }],
        },
      },
      repo,
    );
    const github = await createProjectIntegration(
      {
        projectId,
        kind: "github_token",
        externalScope: { repos: [{ id: 1, fullName: "team/api" }] },
      },
      repo,
    );

    expect(second.kind).toBe("bitbucket");
    expect(github.kind).toBe("github_token");
  });

  test("updateProjectIntegrationScope replaces a Bitbucket integration's repos", async () => {
    const repo = makeRepo();
    const created = await createProjectIntegration(
      { projectId, kind: "bitbucket", externalScope: { repos: [REPO] } },
      repo,
    );
    const web = { workspace: "team", slug: "web", fullName: "team/web" };

    const updated = await updateProjectIntegrationScope(
      {
        id: created.id,
        projectId,
        kind: "bitbucket",
        externalScope: { repos: [REPO, web] },
      },
      repo,
    );

    if (updated.kind !== "bitbucket") throw new Error("expected bitbucket");
    expect(updated.scope.repos).toEqual([REPO, web]);
  });
});
