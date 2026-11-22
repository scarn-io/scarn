import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAppContext } from "@/lib/di";
import { createApp } from "@scarn/api/app";
import { createTestUserAndSession } from "@scarn/identity/testing";
import { createScarnTreaty } from "tests/treaty";
import { RecordingAnalytics } from "@/lib/analytics/recording-analytics";
import {
  createGitHubEnvGuard,
  installGitHubFetchStub,
  seedInstallation,
} from "./project-setup-test-support";

/**
 * `POST /projects` with `issueTracker: { type: "github_app" }`. Mutates the
 * GitHub App env and `globalThis.fetch`, so tests run serially.
 */
describe("POST /projects — GitHub App issue tracker", () => {
  const analytics = new RecordingAnalytics();
  const appContext = createAppContext({ analytics });
  const apiClient = createScarnTreaty(createApp(appContext));
  const env = createGitHubEnvGuard();

  beforeEach(env.clear);
  afterEach(env.restore);

  const createOwnerWithInstallation = async (
    label: string,
    repo: { id: number; fullName: string },
  ) => {
    const owner = await createTestUserAndSession({
      email: `github-app-${label}-${crypto.randomUUID()}@example.com`,
    });
    const installationId = `github-app-${label}-${crypto.randomUUID()}`;
    await seedInstallation(
      appContext.githubInstallationRepo,
      owner.userId,
      installationId,
      repo,
    );
    return { owner, installationId };
  };

  const listIntegrations = async (
    projectId: string,
    headers: Record<string, string>,
  ) =>
    await apiClient.api.projects({ projectId }).integrations.get({ headers });

  test("creates a project + integration and syncs when the App is configured", async () => {
    env.configureApp();
    installGitHubFetchStub();
    const repo = { id: 1, fullName: "scarn-io/scarn" };
    const { owner, installationId } = await createOwnerWithInstallation(
      "success",
      repo,
    );

    const { data, error } = await apiClient.api.projects.post(
      {
        name: "scarn",
        description: null,
        gitUrl: "https://github.com/scarn-io/scarn.git",
        issueTracker: { type: "github_app", installationId },
      },
      { headers: owner.authHeaders },
    );

    expect(error).toBeNull();
    expect(data).toMatchObject({
      name: "scarn",
      gitUrl: "https://github.com/scarn-io/scarn.git",
      initialSyncFailed: false,
    });
    if (!data) throw new Error("Expected data");

    const integrations = await listIntegrations(data.id, owner.authHeaders);
    expect(integrations.error).toBeNull();
    expect(integrations.data).toHaveLength(1);
    expect(integrations.data?.[0]).toMatchObject({
      kind: "github_app",
      platform: "github",
      authMode: "github_app",
      installationId,
      externalScope: { repos: [repo] },
      status: "active",
      lastError: null,
    });
    expect(integrations.data?.[0]?.lastSyncedAt).not.toBeNull();
  });

  test("connects a repo whose URL uses its old name, scoped to the repo's current name", async () => {
    env.configureApp();
    const repo = { id: 9, fullName: "acme-co/renamed" };
    installGitHubFetchStub({ repo });
    const { owner, installationId } = await createOwnerWithInstallation(
      "renamed",
      repo,
    );

    const { data, error } = await apiClient.api.projects.post(
      {
        name: "renamed",
        description: null,
        gitUrl: "https://github.com/acme/old-name.git",
        issueTracker: { type: "github_app", installationId },
      },
      { headers: owner.authHeaders },
    );

    expect(error).toBeNull();
    if (!data) throw new Error("Expected data");
    const integrations = await listIntegrations(data.id, owner.authHeaders);
    expect(integrations.data?.[0]).toMatchObject({
      kind: "github_app",
      installationId,
      externalScope: { repos: [repo] },
    });
  });

  test("keeps the project when the first sync fails, and records the failure", async () => {
    const { owner, installationId } = await createOwnerWithInstallation(
      "sync-failed",
      { id: 2, fullName: "connorivy/failing-repo" },
    );

    const { data, error } = await apiClient.api.projects.post(
      {
        name: "failing-repo",
        description: null,
        gitUrl: "https://github.com/connorivy/failing-repo.git",
        issueTracker: { type: "github_app", installationId },
      },
      { headers: owner.authHeaders },
    );

    expect(error).toBeNull();
    expect(data).toMatchObject({
      name: "failing-repo",
      initialSyncFailed: true,
    });
    if (!data) throw new Error("Expected data");

    const integrations = await listIntegrations(data.id, owner.authHeaders);
    expect(integrations.data).toHaveLength(1);
    expect(integrations.data?.[0]?.status).toBe("error");
    expect(integrations.data?.[0]?.lastError).toBeTruthy();
  });

  test("reports project_created with source github and the requested origin", async () => {
    const { owner, installationId } = await createOwnerWithInstallation(
      "analytics",
      { id: 7, fullName: "connorivy/analytics-repo" },
    );

    const { data, error } = await apiClient.api.projects.post(
      {
        name: "analytics-repo",
        description: null,
        gitUrl: "https://github.com/connorivy/analytics-repo.git",
        origin: "cli_api",
        issueTracker: { type: "github_app", installationId },
      },
      { headers: owner.authHeaders },
    );

    expect(error).toBeNull();
    if (!data) throw new Error("Expected data");
    expect(
      analytics
        .callsFor("project_created")
        .filter((call) => call.properties.project_id === data.id),
    ).toEqual([
      {
        distinctId: owner.userId,
        event: "project_created",
        properties: {
          project_id: data.id,
          source: "github",
          origin: "cli_api",
        },
      },
    ]);
  });

  test("returns 403 and creates nothing when the installation belongs to someone else", async () => {
    const { installationId } = await createOwnerWithInstallation("owner", {
      id: 3,
      fullName: "connorivy/private-repo",
    });
    const attacker = await createTestUserAndSession({
      email: `github-app-attacker-${crypto.randomUUID()}@example.com`,
    });

    const { data, error } = await apiClient.api.projects.post(
      {
        name: "private-repo",
        description: null,
        gitUrl: "https://github.com/connorivy/private-repo.git",
        issueTracker: { type: "github_app", installationId },
      },
      { headers: attacker.authHeaders },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(403);
    expect(error?.value).toMatchObject({
      code: "GITHUB_INSTALLATION_NOT_OWNED",
    });
    const projects = await apiClient.api.projects.get({
      headers: attacker.authHeaders,
    });
    expect(projects.data).toEqual([]);
  });

  test("returns 403 when the installation does not exist", async () => {
    const owner = await createTestUserAndSession({
      email: `github-app-no-install-${crypto.randomUUID()}@example.com`,
    });

    const { data, error } = await apiClient.api.projects.post(
      {
        name: "ghost-repo",
        description: null,
        gitUrl: "https://github.com/connorivy/ghost-repo.git",
        issueTracker: {
          type: "github_app",
          installationId: `nonexistent-${crypto.randomUUID()}`,
        },
      },
      { headers: owner.authHeaders },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(403);
    expect(error?.value).toMatchObject({
      code: "GITHUB_INSTALLATION_NOT_OWNED",
    });
  });

  test("returns 422 when the installation can't see the repo", async () => {
    const { owner, installationId } = await createOwnerWithInstallation(
      "not-covered",
      { id: 8, fullName: "connorivy/covered" },
    );

    const { data, error } = await apiClient.api.projects.post(
      {
        name: "other",
        description: null,
        gitUrl: "https://github.com/connorivy/other.git",
        issueTracker: { type: "github_app", installationId },
      },
      { headers: owner.authHeaders },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({
      code: "GITHUB_INSTALLATION_REPO_NOT_COVERED",
    });
  });

  test("allows a second project against an already-linked repo", async () => {
    const { owner, installationId } = await createOwnerWithInstallation(
      "duplicate",
      { id: 6, fullName: "connorivy/shared-repo" },
    );
    const create = (name: string) =>
      apiClient.api.projects.post(
        {
          name,
          description: null,
          gitUrl: "https://github.com/connorivy/shared-repo.git",
          issueTracker: { type: "github_app", installationId },
        },
        { headers: owner.authHeaders },
      );

    const first = await create("First Project");
    const second = await create("Second Project");

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(second.data).toMatchObject({ name: "Second Project" });
    expect(second.data?.id).not.toBe(first.data?.id);
  });
});
