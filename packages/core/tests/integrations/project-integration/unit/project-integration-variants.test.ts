import { describe, expect, test } from "bun:test";
import {
  GitHubAppProjectIntegration,
  JiraProjectIntegration,
  ProjectIntegrationEntity,
  isGitHubAppIntegration,
  type ProjectIntegrationRowProps,
} from "@/integrations/project-integration/domain/project-integration-entity";
import { parseUuidV7, createUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError } from "@/lib/errors";

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f02");
const syncedAt = new Date("2026-05-24T12:00:00Z");

const githubApp = (repos = [{ id: 1, fullName: "acme/repo" }]) =>
  GitHubAppProjectIntegration.create({
    projectId,
    installationId: "123",
    scope: { repos },
  });

const jira = (projectKeys = ["ACME"]) =>
  JiraProjectIntegration.create({
    projectId,
    scope: { baseUrl: "https://acme.atlassian.net", projectKeys },
  });

const errorCode = (fn: () => unknown): string | null => {
  try {
    fn();
  } catch (caught: unknown) {
    if (caught instanceof CoreValidationError) return caught.code;
    throw caught;
  }
  return null;
};

const row = (
  overrides: Partial<ProjectIntegrationRowProps>,
): ProjectIntegrationRowProps => ({
  id: createUuidV7(),
  projectId,
  kind: "github_app",
  installationId: "123",
  externalScopeJson: { repos: [{ id: 1, fullName: "acme/repo" }] },
  status: "active",
  lastSyncedAt: null,
  lastError: null,
  firstSyncHorizonDays: null,
  ...overrides,
});

describe("GitHubAppProjectIntegration", () => {
  test("derives platform and authMode from its kind", () => {
    const integration = githubApp();
    expect(integration.kind).toBe("github_app");
    expect(integration.platform).toBe("github");
    expect(integration.authMode).toBe("github_app");
  });

  test("requires an installation id", () => {
    expect(
      errorCode(() =>
        GitHubAppProjectIntegration.create({
          projectId,
          installationId: "  ",
          scope: { repos: [{ id: 1, fullName: "acme/repo" }] },
        }),
      ),
    ).toBe("PROJECT_INTEGRATION_INSTALLATION_REQUIRED");
  });

  test("requires at least one repo", () => {
    expect(errorCode(() => githubApp([]))).toBe(
      "PROJECT_INTEGRATION_REPOS_REQUIRED",
    );
  });

  test("rejects a repo without a fullName", () => {
    expect(errorCode(() => githubApp([{ id: 1, fullName: " " }]))).toBe(
      "PROJECT_INTEGRATION_REPO_INVALID",
    );
  });

  test("rejects a duplicate repo", () => {
    expect(
      errorCode(() =>
        githubApp([
          { id: 1, fullName: "acme/a" },
          { id: 1, fullName: "acme/a" },
        ]),
      ),
    ).toBe("PROJECT_INTEGRATION_REPO_DUPLICATE");
  });

  test("withRepos replaces the repos and re-checks them", () => {
    const integration = githubApp();
    const next = integration.withRepos([{ id: 2, fullName: "acme/other" }]);
    expect(next.scope.repos).toEqual([{ id: 2, fullName: "acme/other" }]);
    expect(next.installationId).toBe("123");
    expect(errorCode(() => integration.withRepos([]))).toBe(
      "PROJECT_INTEGRATION_REPOS_REQUIRED",
    );
  });
});

describe("JiraProjectIntegration", () => {
  test("derives platform and authMode from its kind and has no installation", () => {
    const integration = jira();
    expect(integration.kind).toBe("jira");
    expect(integration.platform).toBe("jira");
    expect(integration.authMode).toBe("user_credential");
    expect("installationId" in integration).toBe(false);
    expect(integration.toJSON().installationId).toBeNull();
  });

  test("requires a base URL", () => {
    expect(
      errorCode(() =>
        JiraProjectIntegration.create({
          projectId,
          scope: { baseUrl: " ", projectKeys: ["ACME"] },
        }),
      ),
    ).toBe("PROJECT_INTEGRATION_JIRA_BASE_URL_REQUIRED");
  });

  test("requires at least one project key", () => {
    expect(errorCode(() => jira([]))).toBe(
      "PROJECT_INTEGRATION_JIRA_PROJECT_KEYS_REQUIRED",
    );
  });

  test("withJiraScope replaces the scope", () => {
    const next = jira().withJiraScope({
      baseUrl: "https://other.atlassian.net",
      projectKeys: ["OPS"],
    });
    expect(next.scope).toEqual({
      baseUrl: "https://other.atlassian.net",
      projectKeys: ["OPS"],
    });
  });
});

describe("shared transitions keep the variant type", () => {
  test("withSyncError on a GitHub App integration still exposes installationId", () => {
    const errored: GitHubAppProjectIntegration = githubApp().withSyncError(
      "boom",
      syncedAt,
    );
    const installationId: string = errored.installationId;
    expect(installationId).toBe("123");
    expect(errored.status).toBe("error");
    expect(errored.lastError).toBe("boom");
  });

  test("withSyncSuccess on a Jira integration stays Jira", () => {
    const synced: JiraProjectIntegration = jira()
      .withSyncError("boom", syncedAt)
      .withSyncSuccess(syncedAt);
    expect(synced).toBeInstanceOf(JiraProjectIntegration);
    expect(synced.status).toBe("active");
    expect(synced.lastError).toBeNull();
    expect(synced.lastSyncedAt).toEqual(syncedAt);
  });

  test("rejects a negative first-sync horizon", () => {
    expect(
      errorCode(() =>
        JiraProjectIntegration.create({
          projectId,
          firstSyncHorizonDays: -1,
          scope: { baseUrl: "https://acme.atlassian.net", projectKeys: ["A"] },
        }),
      ),
    ).toBe("PROJECT_INTEGRATION_FIRST_SYNC_HORIZON_DAYS_INVALID");
  });
});

describe("ProjectIntegrationEntity companion", () => {
  test("create dispatches on kind", () => {
    const app = ProjectIntegrationEntity.create({
      kind: "github_app",
      projectId,
      installationId: "9",
      scope: { repos: [{ id: 1, fullName: "acme/repo" }] },
    });
    const site = ProjectIntegrationEntity.create({
      kind: "jira",
      projectId,
      scope: { baseUrl: "https://acme.atlassian.net", projectKeys: ["A"] },
    });
    expect(app).toBeInstanceOf(GitHubAppProjectIntegration);
    expect(site).toBeInstanceOf(JiraProjectIntegration);
    expect(isGitHubAppIntegration(app)).toBe(true);
    expect(isGitHubAppIntegration(site)).toBe(false);
  });

  test("rehydrate dispatches on kind and round-trips toJSON", () => {
    for (const integration of [githubApp(), jira()]) {
      const restored = ProjectIntegrationEntity.rehydrate(integration.toJSON());
      expect(restored.constructor).toBe(integration.constructor);
      expect(restored.toJSON()).toEqual(integration.toJSON());
    }
  });

  test.each([
    ["github_app without an installation id", row({ installationId: null })],
    [
      "jira with an installation id",
      row({
        kind: "jira",
        installationId: "https://acme.atlassian.net",
        externalScopeJson: {
          baseUrl: "https://acme.atlassian.net",
          projectKeys: ["A"],
        },
      }),
    ],
    [
      "github_app with a Jira scope",
      row({
        externalScopeJson: {
          baseUrl: "https://acme.atlassian.net",
          projectKeys: ["A"],
        },
      }),
    ],
    ["jira with a GitHub scope", row({ kind: "jira", installationId: null })],
  ])("rehydrate rejects %s", (_label, invalidRow) => {
    expect(
      errorCode(() => ProjectIntegrationEntity.rehydrate(invalidRow)),
    ).toBe("PROJECT_INTEGRATION_ROW_INVALID");
  });
});
