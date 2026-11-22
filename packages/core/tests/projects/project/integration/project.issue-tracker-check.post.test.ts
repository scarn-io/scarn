import { afterEach, describe, expect, mock, test } from "bun:test";
import { createScarnTreaty } from "tests/treaty";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import {
  createSecretsTestUser,
  githubTokenInput,
  jiraApiKeyInput,
  SECRETS_TEST_NOW,
} from "tests/secrets/secret/integration/secret-test-support";
import {
  installJiraIssuesClientMock,
  uninstallJiraIssuesClientMock,
} from "tests/integrations/github-ingest/integration/jira-issues-client-mock-support";
import {
  createGitHubEnvGuard,
  installGitHubFetchStub,
  loadSecretLastUsedAt,
  type GitHubStubOptions,
} from "./project-setup-test-support";

const GIT_URL = "https://github.com/acme/api.git";
const JIRA_BASE_URL = "https://acme.atlassian.net";

/**
 * `POST /projects/issue-tracker-check`. The Jira client is replaced via
 * `mock.module` and `globalThis.fetch` is stubbed for GitHub, so
 * `createApp`/`createAppContext` load after the mock and tests run serially.
 */
describe("POST /projects/issue-tracker-check", () => {
  const env = createGitHubEnvGuard();

  afterEach(async () => {
    env.restore();
    await uninstallJiraIssuesClientMock();
    mock.restore();
  });

  const setUp = async (
    options: {
      github?: GitHubStubOptions;
      jira?: { failureStatus?: number; missingProjectKeys?: string[] };
    } = {},
  ) => {
    env.clear();
    const githubRequests = installGitHubFetchStub(options.github);
    const { calls: jiraCalls } = await installJiraIssuesClientMock(
      options.jira,
    );
    const { createApp } = await import("@scarn/api/app");
    const { createAppContext } = await import("@/lib/di");
    const apiClient = createScarnTreaty(
      createApp(
        createAppContext({ timeProvider: fixedTimeProvider(SECRETS_TEST_NOW) }),
      ),
    );
    const owner = await createSecretsTestUser();
    const check = (
      issueTracker: Record<string, unknown>,
      gitUrl = GIT_URL,
      headers: Record<string, string> = owner.authHeaders,
    ) =>
      apiClient.api.projects["issue-tracker-check"].post(
        { gitUrl, issueTracker: issueTracker as never },
        { headers },
      );
    const listProjects = () =>
      unwrapAsync(apiClient.api.projects.get({ headers: owner.authHeaders }));
    return { apiClient, owner, check, githubRequests, jiraCalls, listProjects };
  };

  test("a GitHub token that can read the repo returns its login and issue status", async () => {
    const { check, githubRequests, listProjects } = await setUp({
      github: {
        login: "octo-cat",
        repo: { id: 9, fullName: "acme/api", hasIssues: false },
      },
    });

    const result = await unwrapAsync(
      check({ type: "github_token", credential: { token: "ghp_check_1" } }),
    );

    expect(result).toEqual({
      ok: true,
      account: "octo-cat",
      issuesEnabled: false,
      repo: { id: 9, fullName: "acme/api" },
    });
    for (const request of githubRequests) {
      expect(request.authorization).toBe("Bearer ghp_check_1");
    }
    expect(await listProjects()).toEqual([]);
  });

  test("a rejected GitHub token is GITHUB_TOKEN_REJECTED without the token", async () => {
    const { check } = await setUp({ github: { repoStatus: 401 } });

    const { data, error } = await check({
      type: "github_token",
      credential: { token: "ghp_leak_check_42" },
    });

    expect(data).toBeNull();
    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({ code: "GITHUB_TOKEN_REJECTED" });
    expect(JSON.stringify(error?.value)).not.toContain("ghp_leak_check_42");
  });

  test("a saved GitHub token is checked without being marked used", async () => {
    const { apiClient, owner, check } = await setUp();
    const secret = await unwrapAsync(
      apiClient.api.me.secrets.post(githubTokenInput(), {
        headers: owner.authHeaders,
      }),
    );

    await unwrapAsync(
      check({ type: "github_token", credential: { secretId: secret.id } }),
    );

    expect(await loadSecretLastUsedAt(secret.id)).toBeNull();
  });

  test("another user's saved key is a 404 with no outbound call", async () => {
    const { apiClient, check, githubRequests, jiraCalls } = await setUp();
    const stranger = await createSecretsTestUser();
    const githubSecret = await unwrapAsync(
      apiClient.api.me.secrets.post(githubTokenInput(), {
        headers: stranger.authHeaders,
      }),
    );
    const jiraSecret = await unwrapAsync(
      apiClient.api.me.secrets.post(jiraApiKeyInput(), {
        headers: stranger.authHeaders,
      }),
    );

    const github = await check({
      type: "github_token",
      credential: { secretId: githubSecret.id },
    });
    const jira = await check({
      type: "jira",
      baseUrl: JIRA_BASE_URL,
      projectKeys: ["ACME"],
      credential: { secretId: jiraSecret.id },
    });

    expect(github.error?.status).toBe(404);
    expect(jira.error?.status).toBe(404);
    expect(githubRequests).toEqual([]);
    expect(jiraCalls).toEqual([]);
  });

  test("a credential for the wrong platform is CREDENTIAL_PLATFORM_MISMATCH", async () => {
    const { check, githubRequests, jiraCalls } = await setUp();

    const github = await check({
      type: "github_token",
      credential: { email: "me@acme.test", apiKey: "jira-key" },
    });
    const jira = await check({
      type: "jira",
      baseUrl: JIRA_BASE_URL,
      projectKeys: ["ACME"],
      credential: { token: "ghp_wrong" },
    });

    expect(github.error?.value).toMatchObject({
      code: "CREDENTIAL_PLATFORM_MISMATCH",
    });
    expect(jira.error?.value).toMatchObject({
      code: "CREDENTIAL_PLATFORM_MISMATCH",
    });
    expect(githubRequests).toEqual([]);
    expect(jiraCalls).toEqual([]);
  });

  test("a GitHub token on a non-GitHub URL is ISSUE_TRACKER_HOST_MISMATCH", async () => {
    const { check, githubRequests } = await setUp();

    const { error } = await check(
      { type: "github_token", credential: { token: "ghp_x" } },
      "https://bitbucket.org/acme/api.git",
    );

    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({ code: "ISSUE_TRACKER_HOST_MISMATCH" });
    expect(githubRequests).toEqual([]);
  });

  test("Jira checks the account and every project key with basic auth", async () => {
    const { check, jiraCalls, listProjects } = await setUp();

    const result = await unwrapAsync(
      check(
        {
          type: "jira",
          baseUrl: JIRA_BASE_URL,
          projectKeys: ["ACME", "OPS"],
          credential: { email: "me@acme.test", apiKey: "jira-token-1" },
        },
        "https://git.example.com/acme/api.git",
      ),
    );

    expect(result).toEqual({
      ok: true,
      account: "Jira Tester",
      issuesEnabled: true,
      repo: null,
    });
    expect(jiraCalls).toHaveLength(3);
    for (const call of jiraCalls) {
      expect(call).toEqual({
        baseUrl: JIRA_BASE_URL,
        email: "me@acme.test",
        apiToken: "jira-token-1",
      });
    }
    expect(await listProjects()).toEqual([]);
  });

  test("a Jira project key the account can't see is JIRA_PROJECT_NOT_FOUND", async () => {
    const { check } = await setUp({ jira: { missingProjectKeys: ["NOPE"] } });

    const { error } = await check({
      type: "jira",
      baseUrl: JIRA_BASE_URL,
      projectKeys: ["ACME", "NOPE"],
      credential: { email: "me@acme.test", apiKey: "jira-token-1" },
    });

    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({ code: "JIRA_PROJECT_NOT_FOUND" });
  });

  test("a rejected Jira key is JIRA_API_KEY_REJECTED without the token", async () => {
    const { check } = await setUp({ jira: { failureStatus: 401 } });

    const { error } = await check({
      type: "jira",
      baseUrl: JIRA_BASE_URL,
      projectKeys: ["ACME"],
      credential: { email: "me@acme.test", apiKey: "jira-leak-token-77" },
    });

    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({ code: "JIRA_API_KEY_REJECTED" });
    expect(JSON.stringify(error?.value)).not.toContain("jira-leak-token-77");
  });
});
