import { afterEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { projectMemberships, secrets } from "@/lib/db/schema";
import { createUuidV7, parseUuidV7 } from "@/common/contracts/uuid-v7";
import { createLogger } from "@scarn/observability/logging";
import { createScarnTreaty } from "tests/treaty";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import {
  createSecretsTestUser,
  daysFromNow,
  jiraApiKeyInput,
  SECRETS_TEST_NOW,
} from "tests/secrets/secret/integration/secret-test-support";
import {
  installJiraIssuesClientMock,
  JIRA_UNAUTHORIZED_RESPONSE_BODY,
  uninstallJiraIssuesClientMock,
} from "./jira-issues-client-mock-support";

const JIRA_BASE_URL = "https://acme.atlassian.net";

/**
 * Jira sync with a per-request credential: a saved secret or a pasted
 * email + API token. The Jira client is replaced via `mock.module`
 * (`jira-issues-client-mock-support.ts`), so `createApp`/`createAppContext`
 * are imported after the mock is installed and every test runs serially.
 */
describe("POST /projects/:projectId/integrations/:integrationId/sync — Jira credentials", () => {
  afterEach(async () => {
    await uninstallJiraIssuesClientMock();
    mock.restore();
  });

  const setUp = async (options: { failureStatus?: number } = {}) => {
    const { calls } = await installJiraIssuesClientMock(options);
    const { createApp } = await import("@scarn/api/app");
    const { createAppContext } = await import("@/lib/di");
    const logLines: string[] = [];
    const logger = createLogger(
      { name: "jira-credential-test", level: "debug" },
      {
        write: (line: string) => {
          logLines.push(line);
        },
      },
    );
    const apiClient = createScarnTreaty(
      createApp(
        createAppContext({
          timeProvider: fixedTimeProvider(SECRETS_TEST_NOW),
          logger,
        }),
      ),
    );

    const owner = await createSecretsTestUser();
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Jira Credential Sync Project",
          description: "Project for Jira credential sync tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: owner.authHeaders },
      ),
    );
    const integration = await unwrapAsync(
      apiClient.api.projects({ projectId: project.id }).integrations.post(
        {
          kind: "jira",
          externalScope: { baseUrl: JIRA_BASE_URL, projectKeys: ["ACME"] },
        },
        { headers: owner.authHeaders },
      ),
    );

    /** Untyped body so invalid shapes can be sent to check the 422s. */
    const sync = (
      body: Record<string, unknown>,
      headers: { authorization: string } = owner.authHeaders,
    ) =>
      apiClient.api
        .projects({ projectId: project.id })
        .integrations({ integrationId: integration.id })
        .sync.post(body as never, { headers });

    const loadIntegration = async () => {
      const list = await unwrapAsync(
        apiClient.api
          .projects({ projectId: project.id })
          .integrations.get({ headers: owner.authHeaders }),
      );
      return list.find((entry) => entry.id === integration.id);
    };

    const loadSecretRow = async (secretId: string) => {
      const [row] = await getDb()
        .select()
        .from(secrets)
        .where(eq(secrets.id, secretId));
      return row;
    };

    return {
      apiClient,
      calls,
      logLines,
      owner,
      project,
      integration,
      sync,
      loadIntegration,
      loadSecretRow,
    };
  };

  test("a saved secret sends its own email and token, and marks it used", async () => {
    const { apiClient, calls, owner, sync, loadSecretRow } = await setUp();
    const token = `saved-token-${crypto.randomUUID()}`;
    const secret = await unwrapAsync(
      apiClient.api.me.secrets.post(
        jiraApiKeyInput({ email: "saved@acme.test", value: token }),
        { headers: owner.authHeaders },
      ),
    );

    await unwrapAsync(sync({ secretId: secret.id }));

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toEqual({
        baseUrl: JIRA_BASE_URL,
        email: "saved@acme.test",
        apiToken: token,
      });
    }
    expect((await loadSecretRow(secret.id))?.lastUsedAt?.toISOString()).toBe(
      SECRETS_TEST_NOW.toISOString(),
    );
  });

  test("a pasted email and token are sent exactly as given", async () => {
    const { calls, sync } = await setUp();

    await unwrapAsync(
      sync({ email: "pasted@acme.test", apiKey: "pasted-token-1234" }),
    );

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toEqual({
        baseUrl: JIRA_BASE_URL,
        email: "pasted@acme.test",
        apiToken: "pasted-token-1234",
      });
    }
  });

  test("two users syncing the same integration each use their own email", async () => {
    const { apiClient, calls, owner, project, sync } = await setUp();
    const teammate = await createSecretsTestUser();
    await getDb()
      .insert(projectMemberships)
      .values({
        projectId: project.id,
        userId: teammate.userId,
        role: "write",
      });

    const ownerSecret = await unwrapAsync(
      apiClient.api.me.secrets.post(
        jiraApiKeyInput({ email: "owner@acme.test", value: "owner-token" }),
        { headers: owner.authHeaders },
      ),
    );
    const teammateSecret = await unwrapAsync(
      apiClient.api.me.secrets.post(
        jiraApiKeyInput({
          email: "teammate@acme.test",
          value: "teammate-token",
        }),
        { headers: teammate.authHeaders },
      ),
    );

    await unwrapAsync(sync({ secretId: ownerSecret.id }));
    const ownerCalls = calls.splice(0);
    await unwrapAsync(
      sync({ secretId: teammateSecret.id }, teammate.authHeaders),
    );

    expect(new Set(ownerCalls.map((call) => call.email))).toEqual(
      new Set(["owner@acme.test"]),
    );
    expect(new Set(calls.map((call) => call.email))).toEqual(
      new Set(["teammate@acme.test"]),
    );
  });

  test("422s for both secretId and apiKey, or an apiKey without an email", async () => {
    const { calls, sync } = await setUp();

    const both = await sync({
      secretId: createUuidV7(),
      email: "x@acme.test",
      apiKey: "token",
    });
    const noEmail = await sync({ apiKey: "token" });

    expect(both.error?.status).toBe(422);
    expect(noEmail.error?.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  test("another user's secretId 404s without calling Jira", async () => {
    const { apiClient, calls, sync } = await setUp();
    const stranger = await createSecretsTestUser();
    const strangerSecret = await unwrapAsync(
      apiClient.api.me.secrets.post(jiraApiKeyInput(), {
        headers: stranger.authHeaders,
      }),
    );

    const { error } = await sync({ secretId: strangerSecret.id });

    expect(error?.status).toBe(404);
    expect(error?.value).toMatchObject({ code: "SECRET_NOT_FOUND" });
    expect(calls).toHaveLength(0);
  });

  test("an expired secret fails with SECRET_EXPIRED without calling Jira", async () => {
    const { apiClient, calls, owner, sync, loadSecretRow } = await setUp();
    const secret = await unwrapAsync(
      apiClient.api.me.secrets.post(
        jiraApiKeyInput({ expiresAt: daysFromNow(1) }),
        { headers: owner.authHeaders },
      ),
    );
    await getDb()
      .update(secrets)
      .set({ expiresAt: new Date(daysFromNow(-1)) })
      .where(eq(secrets.id, parseUuidV7(secret.id)));

    const { error } = await sync({ secretId: secret.id });

    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({ code: "SECRET_EXPIRED" });
    expect(calls).toHaveLength(0);
    expect((await loadSecretRow(secret.id))?.lastUsedAt).toBeNull();
  });

  test("a Jira 401 with a saved secret is JIRA_API_KEY_REJECTED, leaks no token or Jira body, and leaves lastUsedAt unset", async () => {
    const { apiClient, owner, sync, loadIntegration, loadSecretRow, logLines } =
      await setUp({ failureStatus: 401 });
    const token = `rejected-token-${crypto.randomUUID()}`;
    const secret = await unwrapAsync(
      apiClient.api.me.secrets.post(
        jiraApiKeyInput({
          name: "Work Jira",
          email: "rejected@acme.test",
          value: token,
        }),
        { headers: owner.authHeaders },
      ),
    );

    const { error } = await sync({ secretId: secret.id });

    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({
      code: "JIRA_API_KEY_REJECTED",
      detail:
        'Jira rejected the saved key "Work Jira". Check its email and token, or replace it.',
    });
    const errorJson = JSON.stringify(error?.value);
    expect(errorJson).not.toContain(token);
    expect(errorJson).not.toContain("rejected@acme.test");
    expect(errorJson).not.toContain("Client must be authenticated");

    const stored = await loadIntegration();
    expect(stored?.status).toBe("error");
    expect(stored?.lastError).toBe(
      'Jira rejected the saved key "Work Jira". Check its email and token, or replace it.',
    );
    expect(stored?.lastError).not.toContain(JIRA_UNAUTHORIZED_RESPONSE_BODY);

    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join("\n")).not.toContain(token);
    expect((await loadSecretRow(secret.id))?.lastUsedAt).toBeNull();
  });

  test("a Jira 401 with a pasted pair says the email and token were rejected", async () => {
    const { sync, loadIntegration } = await setUp({ failureStatus: 401 });

    const { error } = await sync({
      email: "pasted@acme.test",
      apiKey: "pasted-bad-token",
    });

    expect(error?.status).toBe(400);
    expect(error?.value).toMatchObject({
      code: "JIRA_API_KEY_REJECTED",
      detail: "Jira rejected that email and API token.",
    });
    expect((await loadIntegration())?.lastError).toBe(
      "Jira rejected that email and API token.",
    );
  });
});
