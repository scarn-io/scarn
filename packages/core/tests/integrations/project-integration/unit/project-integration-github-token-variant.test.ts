import { describe, expect, test } from "bun:test";
import {
  GitHubAppProjectIntegration,
  GitHubTokenProjectIntegration,
  JiraProjectIntegration,
  ProjectIntegrationEntity,
  isGitHubAppIntegration,
  isGitHubIntegration,
  isUserCredentialIntegration,
} from "@/integrations/project-integration/domain/project-integration-entity";
import { createUuidV7, parseUuidV7 } from "@/common/contracts/uuid-v7";
import { CoreValidationError } from "@/lib/errors";

const projectId = parseUuidV7("0196917c-532c-75aa-b7d5-0a84b71a1f02");

const githubToken = (repos = [{ id: 1, fullName: "acme/repo" }]) =>
  GitHubTokenProjectIntegration.create({ projectId, scope: { repos } });

const errorCode = (fn: () => unknown): string | null => {
  try {
    fn();
  } catch (caught: unknown) {
    if (caught instanceof CoreValidationError) return caught.code;
    throw caught;
  }
  return null;
};

describe("GitHubTokenProjectIntegration", () => {
  test("is a GitHub integration read with a user's credential and has no installation", () => {
    const integration = githubToken();

    expect(integration.kind).toBe("github_token");
    expect(integration.platform).toBe("github");
    expect(integration.authMode).toBe("user_credential");
    expect("installationId" in integration).toBe(false);
    expect(integration.toJSON()).toMatchObject({
      kind: "github_token",
      installationId: null,
      externalScopeJson: { repos: [{ id: 1, fullName: "acme/repo" }] },
    });
  });

  test("checks its repos like the App variant", () => {
    expect(errorCode(() => githubToken([]))).toBe(
      "PROJECT_INTEGRATION_REPOS_REQUIRED",
    );
    expect(
      errorCode(() =>
        githubToken([
          { id: 1, fullName: "acme/a" },
          { id: 1, fullName: "acme/a" },
        ]),
      ),
    ).toBe("PROJECT_INTEGRATION_REPO_DUPLICATE");
  });

  test("withRepos and withSyncError keep the variant", () => {
    const next = githubToken()
      .withRepos([{ id: 2, fullName: "acme/other" }])
      .withSyncError("boom", new Date("2026-05-24T12:00:00Z"));

    expect(next).toBeInstanceOf(GitHubTokenProjectIntegration);
    expect(next.scope.repos).toEqual([{ id: 2, fullName: "acme/other" }]);
    expect(next.status).toBe("error");
  });

  test("the type guards sort it with GitHub and user-credential integrations", () => {
    const token = githubToken();
    const app = GitHubAppProjectIntegration.create({
      projectId,
      installationId: "9",
      scope: { repos: [{ id: 1, fullName: "acme/repo" }] },
    });
    const jira = JiraProjectIntegration.create({
      projectId,
      scope: { baseUrl: "https://acme.atlassian.net", projectKeys: ["A"] },
    });

    expect(isGitHubIntegration(token)).toBe(true);
    expect(isGitHubAppIntegration(token)).toBe(false);
    expect(isUserCredentialIntegration(token)).toBe(true);
    expect(isGitHubIntegration(app)).toBe(true);
    expect(isUserCredentialIntegration(app)).toBe(false);
    expect(isGitHubIntegration(jira)).toBe(false);
    expect(isUserCredentialIntegration(jira)).toBe(true);
  });

  test("create and rehydrate dispatch to the token variant and round-trip", () => {
    const created = ProjectIntegrationEntity.create({
      kind: "github_token",
      projectId,
      scope: { repos: [{ id: 3, fullName: "acme/three" }] },
    });
    const restored = ProjectIntegrationEntity.rehydrate(created.toJSON());

    expect(created).toBeInstanceOf(GitHubTokenProjectIntegration);
    expect(restored).toBeInstanceOf(GitHubTokenProjectIntegration);
    expect(restored.toJSON()).toEqual(created.toJSON());
  });

  test("rehydrate rejects a token row with an installation id", () => {
    expect(
      errorCode(() =>
        ProjectIntegrationEntity.rehydrate({
          id: createUuidV7(),
          projectId,
          kind: "github_token",
          installationId: "123",
          externalScopeJson: { repos: [{ id: 1, fullName: "acme/repo" }] },
          status: "active",
          lastSyncedAt: null,
          lastError: null,
          firstSyncHorizonDays: null,
        }),
      ),
    ).toBe("PROJECT_INTEGRATION_ROW_INVALID");
  });
});
