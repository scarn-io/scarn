import { describe, expect, test } from "bun:test";
import { unwrapAsync } from "tests/utils";
import {
  createSecretsTestClient,
  createSecretsTestUser,
} from "tests/secrets/secret/integration/secret-test-support";

const JIRA_BASE_URL = "https://acme.atlassian.net";

describe("POST /projects/:projectId/integrations — Jira scope", () => {
  const setUp = async () => {
    const apiClient = createSecretsTestClient();
    const owner = await createSecretsTestUser();
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Jira Scope Project",
          description: "Project for Jira scope tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: owner.authHeaders },
      ),
    );
    const postIntegration = (body: Record<string, unknown>) =>
      apiClient.api
        .projects({ projectId: project.id })
        .integrations.post(body, { headers: owner.authHeaders });
    const createIntegration = (externalScope: Record<string, unknown>) =>
      postIntegration({ kind: "jira", externalScope });
    return { createIntegration, postIntegration };
  };

  test.concurrent(
    "a Jira integration is created without an email",
    async () => {
      const { createIntegration } = await setUp();

      const integration = await unwrapAsync(
        createIntegration({ baseUrl: JIRA_BASE_URL, projectKeys: ["ACME"] }),
      );

      expect(integration).toMatchObject({
        kind: "jira",
        platform: "jira",
        authMode: "user_credential",
      });
      expect("installationId" in integration).toBe(false);
      expect(integration.externalScope).toEqual({
        baseUrl: JIRA_BASE_URL,
        projectKeys: ["ACME"],
      });
      expect(JSON.stringify(integration)).not.toContain("email");
    },
  );

  test.concurrent(
    "a Jira scope that includes an email is rejected",
    async () => {
      const { createIntegration } = await setUp();

      const { error } = await createIntegration({
        baseUrl: JIRA_BASE_URL,
        email: "bot@acme.test",
        projectKeys: ["ACME"],
      });

      expect(error?.status).toBe(422);
    },
  );

  test.concurrent(
    "a Jira body carrying an installation id is rejected",
    async () => {
      const { postIntegration } = await setUp();

      const { error } = await postIntegration({
        kind: "jira",
        installationId: JIRA_BASE_URL,
        externalScope: { baseUrl: JIRA_BASE_URL, projectKeys: ["ACME"] },
      });

      expect(error?.status).toBe(422);
    },
  );

  test.concurrent(
    "a GitHub App body with a Jira scope is rejected",
    async () => {
      const { postIntegration } = await setUp();

      const { error } = await postIntegration({
        kind: "github_app",
        installationId: "123",
        externalScope: { baseUrl: JIRA_BASE_URL, projectKeys: ["ACME"] },
      });

      expect(error?.status).toBe(422);
    },
  );
});
