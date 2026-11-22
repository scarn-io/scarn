import { describe, expect, test } from "bun:test";
import { createUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import { CoreError } from "@/lib/errors";
import { noopLogger } from "@scarn/observability/logging";
import { setUpProject } from "@/projects/project/application/set-up-project";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import type { ProjectIntegrationRepo } from "@/integrations/project-integration/application/project-integration-repo";
import type { GitHubInstallationRepo } from "@/integrations/github-installation/application/github-installation-repo";
import { GitHubInstallationEntity } from "@/integrations/github-installation/domain/github-installation-entity";
import type { ProjectIntegrationEntity } from "@/integrations/project-integration/domain/project-integration-entity";
import { createResolverHarness } from "tests/secrets/secret/unit/credential-resolver-test-support";

const GIT_URL = "https://github.com/acme/api.git";

/**
 * Builds `setUpProject` deps whose every side effect is appended to `events`,
 * so tests can assert what happened and in which order.
 */
const createHarness = (
  options: { repoStatus?: number; syncFails?: boolean } = {},
) => {
  const events: string[] = [];
  const { deps: credentialDeps, owner, saveSecret } = createResolverHarness();
  const integrations: ProjectIntegrationEntity[] = [];
  const installations: GitHubInstallationEntity[] = [];

  const projectIntegrationRepo = {
    create: (integration: ProjectIntegrationEntity) => {
      events.push(`integration:${integration.kind}`);
      integrations.push(integration);
      return Promise.resolve(integration);
    },
    listByProjectId: () => Promise.resolve([]),
  } as unknown as ProjectIntegrationRepo;

  const githubInstallationRepo = {
    findByInstallationId: (installationId: string) =>
      Promise.resolve(
        installations.find((i) => i.installationId === installationId) ?? null,
      ),
    findByInstalledByUserId: (userId: UuidV7) =>
      Promise.resolve(
        installations.filter((i) => i.installedByUserId === userId),
      ),
  } as unknown as GitHubInstallationRepo;

  const fetchImpl = ((input: string | URL) => {
    const path = new URL(input).pathname;
    events.push(`github:${path}`);
    const status = path === "/user" ? 200 : (options.repoStatus ?? 200);
    const body =
      path === "/user"
        ? { login: "octo" }
        : { id: 11, full_name: "acme/api", has_issues: true };
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as typeof fetch;

  const deps = {
    ...credentialDeps,
    githubInstallationRepo,
    projectIntegrationRepo,
    logger: noopLogger,
    fetchImpl,
    createProject: (input: {
      name: string;
      gitUrl: string;
      source: string;
    }) => {
      events.push(`project:${input.source}`);
      return Promise.resolve({
        id: createUuidV7(),
        name: input.name,
        gitUrl: input.gitUrl,
      } as unknown as ProjectContract);
    },
    runInitialSync: (input: { credential: unknown }) => {
      events.push(`sync:${JSON.stringify(input.credential ?? null)}`);
      return options.syncFails
        ? Promise.reject(new Error("sync failed"))
        : Promise.resolve();
    },
  };

  const saveGitHubToken = () =>
    saveSecret(
      {
        kind: "github_token",
        name: "Team GitHub",
        metadata: { login: "octo" },
        expiresAt: null,
      },
      "ghp_saved",
    );

  return {
    deps,
    events,
    integrations,
    installations,
    saveGitHubToken,
    userId: owner.userId,
  };
};

const caughtCode = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof CoreError) return error.code;
    throw error;
  }
  throw new Error("Expected a CoreError");
};

describe("setUpProject", () => {
  test("without an issue tracker it only creates the project", async () => {
    const { deps, events, userId } = createHarness();

    const result = await setUpProject(
      { name: "API", description: null, gitUrl: GIT_URL, userId },
      deps,
    );

    expect(result.initialSyncFailed).toBe(false);
    expect(events).toEqual(["project:github"]);
  });

  test("checks access, then creates the project, then the integration, then syncs with the same credential", async () => {
    const { deps, events, integrations, userId } = createHarness();

    const result = await setUpProject(
      {
        name: "API",
        description: null,
        gitUrl: GIT_URL,
        userId,
        issueTracker: { type: "github_token", credential: { token: "ghp_t" } },
      },
      deps,
    );

    expect(result.initialSyncFailed).toBe(false);
    expect(events).toEqual([
      "github:/repos/acme/api",
      "github:/user",
      "project:github",
      "integration:github_token",
      'sync:{"token":"ghp_t"}',
    ]);
    expect(integrations[0]?.toJSON().externalScopeJson).toEqual({
      repos: [{ id: 11, fullName: "acme/api" }],
    });
  });

  test("an inaccessible repo stops before anything is created", async () => {
    const { deps, events, userId } = createHarness({ repoStatus: 404 });

    const code = await caughtCode(() =>
      setUpProject(
        {
          name: "API",
          description: null,
          gitUrl: GIT_URL,
          userId,
          issueTracker: { type: "github_token", credential: { token: "t" } },
        },
        deps,
      ),
    );

    expect(code).toBe("GITHUB_REPO_NOT_ACCESSIBLE");
    expect(events).toEqual(["github:/repos/acme/api"]);
  });

  test("a GitHub tracker on another host is ISSUE_TRACKER_HOST_MISMATCH before any call", async () => {
    const { deps, events, userId } = createHarness();

    const code = await caughtCode(() =>
      setUpProject(
        {
          name: "API",
          description: null,
          gitUrl: "https://gitlab.com/acme/api.git",
          userId,
          issueTracker: { type: "github_token", credential: { token: "t" } },
        },
        deps,
      ),
    );

    expect(code).toBe("ISSUE_TRACKER_HOST_MISMATCH");
    expect(events).toEqual([]);
  });

  test("a failed first sync keeps the project and integration", async () => {
    const { deps, events, userId } = createHarness({ syncFails: true });

    const result = await setUpProject(
      {
        name: "API",
        description: null,
        gitUrl: GIT_URL,
        userId,
        issueTracker: { type: "github_token", credential: { token: "t" } },
      },
      deps,
    );

    expect(result.initialSyncFailed).toBe(true);
    expect(events).toContain("integration:github_token");
  });

  test("autoSync with a saved token lends it to the new integration", async () => {
    const { deps, integrations, saveGitHubToken, userId } = createHarness();
    const secret = await saveGitHubToken();

    await setUpProject(
      {
        name: "API",
        description: null,
        gitUrl: GIT_URL,
        userId,
        issueTracker: {
          type: "github_token",
          credential: { secretId: secret.id },
          autoSync: true,
        },
      },
      deps,
    );

    expect(integrations[0]?.syncSecretId).toBe(secret.id);
  });

  test("a saved token without autoSync is not lent", async () => {
    const { deps, integrations, saveGitHubToken, userId } = createHarness();
    const secret = await saveGitHubToken();

    await setUpProject(
      {
        name: "API",
        description: null,
        gitUrl: GIT_URL,
        userId,
        issueTracker: {
          type: "github_token",
          credential: { secretId: secret.id },
        },
      },
      deps,
    );

    expect(integrations[0]?.syncSecretId).toBeNull();
  });

  test("autoSync with a pasted token is rejected before anything is created", async () => {
    const { deps, events, userId } = createHarness();

    const code = await caughtCode(() =>
      setUpProject(
        {
          name: "API",
          description: null,
          gitUrl: GIT_URL,
          userId,
          issueTracker: {
            type: "github_token",
            credential: { token: "t" },
            autoSync: true,
          },
        },
        deps,
      ),
    );

    expect(code).toBe("PROJECT_INTEGRATION_AUTO_SYNC_NEEDS_SAVED_KEY");
    expect(events).not.toContain("project:github");
  });

  test("a GitHub App tracker uses the installation's repo and syncs without a credential", async () => {
    const { deps, events, installations, integrations, userId } =
      createHarness();
    installations.push(
      GitHubInstallationEntity.create({
        installationId: "77",
        accountLogin: "acme",
        accountType: "Organization",
        targetType: "selected",
        selectedRepositories: [{ id: 5, fullName: "Acme/API" }],
        installedByUserId: userId,
      }),
    );

    await setUpProject(
      {
        name: "API",
        description: null,
        gitUrl: GIT_URL,
        userId,
        issueTracker: { type: "github_app", installationId: "77" },
      },
      deps,
    );

    expect(events).toEqual([
      "project:github",
      "integration:github_app",
      "sync:null",
    ]);
    expect(integrations[0]?.toJSON()).toMatchObject({
      installationId: "77",
      externalScopeJson: { repos: [{ id: 5, fullName: "Acme/API" }] },
    });
  });
});
