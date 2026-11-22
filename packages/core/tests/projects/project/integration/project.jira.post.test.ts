import { afterEach, describe, expect, mock, test } from "bun:test";
import { createScarnTreaty } from "tests/treaty";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import {
  createSecretsTestUser,
  jiraApiKeyInput,
  SECRETS_TEST_NOW,
} from "tests/secrets/secret/integration/secret-test-support";
import {
  installJiraIssuesClientMock,
  uninstallJiraIssuesClientMock,
} from "tests/integrations/github-ingest/integration/jira-issues-client-mock-support";
import {
  countSecretsFor,
  loadSecretLastUsedAt,
} from "./project-setup-test-support";

const JIRA_BASE_URL = "https://acme.atlassian.net";

/**
 * `POST /projects` with a Jira issue tracker. The Jira client is replaced via
 * `mock.module`, so `createApp`/`createAppContext` load after the mock and
 * tests run serially.
 */
describe("POST /projects — Jira issue tracker", () => {
  afterEach(async () => {
    await uninstallJiraIssuesClientMock();
    mock.restore();
  });

  const setUp = async (
    options: { failureStatus?: number; missingProjectKeys?: string[] } = {},
  ) => {
    const { calls } = await installJiraIssuesClientMock(options);
    const { createApp } = await import("@scarn/api/app");
    const { createAppContext } = await import("@/lib/di");
    const apiClient = createScarnTreaty(
      createApp(
        createAppContext({ timeProvider: fixedTimeProvider(SECRETS_TEST_NOW) }),
      ),
    );
    const owner = await createSecretsTestUser();
    const create = (gitUrl: string, credential: Record<string, unknown>) =>
      apiClient.api.projects.post(
        {
          name: "Jira Project",
          description: null,
          gitUrl,
          issueTracker: {
            type: "jira",
            baseUrl: JIRA_BASE_URL,
            projectKeys: ["ACME"],
            credential: credential as never,
          },
        },
        { headers: owner.authHeaders },
      );
    const listProjects = () =>
      unwrapAsync(apiClient.api.projects.get({ headers: owner.authHeaders }));
    return { apiClient, owner, calls, create, listProjects };
  };

  test("any host works, the gitUrl is stored as given, and the pasted pair is sent as basic auth", async () => {
    const { apiClient, owner, calls, create } = await setUp();
    const gitUrl = "git@git.example.com:Team/Service.git";

    const project = await unwrapAsync(
      create(gitUrl, { email: "me@acme.test", apiKey: "jira-token-1" }),
    );

    expect(project).toMatchObject({ gitUrl, initialSyncFailed: false });
    const integrations = await unwrapAsync(
      apiClient.api
        .projects({ projectId: project.id })
        .integrations.get({ headers: owner.authHeaders }),
    );
    expect(integrations).toHaveLength(1);
    expect(integrations[0]).toMatchObject({
      kind: "jira",
      platform: "jira",
      authMode: "user_credential",
      externalScope: { baseUrl: JIRA_BASE_URL, projectKeys: ["ACME"] },
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toEqual({
        baseUrl: JIRA_BASE_URL,
        email: "me@acme.test",
        apiToken: "jira-token-1",
      });
    }
    expect(await countSecretsFor(owner.userId)).toBe(0);
  });

  test("a saved Jira key is used and marked used", async () => {
    const { apiClient, owner, calls, create } = await setUp();
    const secret = await unwrapAsync(
      apiClient.api.me.secrets.post(
        jiraApiKeyInput({ email: "saved@acme.test", value: "saved-token" }),
        { headers: owner.authHeaders },
      ),
    );

    await unwrapAsync(
      create("https://github.com/acme/api.git", { secretId: secret.id }),
    );

    expect(new Set(calls.map((call) => call.email))).toEqual(
      new Set(["saved@acme.test"]),
    );
    expect((await loadSecretLastUsedAt(secret.id))?.toISOString()).toBe(
      SECRETS_TEST_NOW.toISOString(),
    );
  });

  test("a rejected Jira key creates no project", async () => {
    const { create, listProjects } = await setUp({ failureStatus: 401 });

    const { data, error } = await create("https://github.com/acme/api.git", {
      email: "me@acme.test",
      apiKey: "jira-token-1",
    });

    expect(data).toBeNull();
    expect(error?.value).toMatchObject({ code: "JIRA_API_KEY_REJECTED" });
    expect(await listProjects()).toEqual([]);
  });

  test("a missing Jira project creates no project", async () => {
    const { create, listProjects } = await setUp({
      missingProjectKeys: ["ACME"],
    });

    const { error } = await create("https://github.com/acme/api.git", {
      email: "me@acme.test",
      apiKey: "jira-token-1",
    });

    expect(error?.value).toMatchObject({ code: "JIRA_PROJECT_NOT_FOUND" });
    expect(await listProjects()).toEqual([]);
  });
});
