/**
 * Shared set-up for the `PUT`/`DELETE …/integrations/:integrationId/auto-sync`
 * suites. The Jira client is replaced via `mock.module` and
 * `globalThis.fetch` is stubbed for GitHub, so `createApp`/`createAppContext`
 * load after the mocks and tests run serially.
 */

import { getDb } from "@/lib/db";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { projectMemberships } from "@/lib/db/schema";
import type { CreateSecretInput } from "@/secrets/secret/contracts/secret-contracts";
import { createScarnTreaty } from "tests/treaty";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import {
  createSecretsTestUser,
  SECRETS_TEST_NOW,
} from "tests/secrets/secret/integration/secret-test-support";
import { installJiraIssuesClientMock } from "tests/integrations/github-ingest/integration/jira-issues-client-mock-support";

export const JIRA_BASE_URL = "https://acme.atlassian.net";

export type RecordedGitHubRequest = { path: string; authorization: string };

/**
 * Replaces `globalThis.fetch` with a GitHub `GET /repos/{owner}/{name}`
 * stand-in. A repo listed in `repoStatuses` answers with that status; every
 * other repo is readable.
 */
export const installGitHubRepoStub = (
  repoStatuses: Record<string, number> = {},
): RecordedGitHubRequest[] => {
  const requests: RecordedGitHubRequest[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    requests.push({
      path: url.pathname,
      authorization: new Headers(init?.headers).get("authorization") ?? "",
    });
    const match = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (url.hostname !== "api.github.com" || !match) {
      throw new Error(`Unexpected fetch to ${url.toString()}`);
    }
    const fullName = `${match[1] ?? ""}/${match[2] ?? ""}`;
    const status = repoStatuses[fullName] ?? 200;
    const body =
      status === 200
        ? { id: 1, full_name: fullName, has_issues: true }
        : { message: "Not Found" };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  return requests;
};

export const setUpAutoSyncTest = async (
  options: {
    jira?: { failureStatus?: number; missingProjectKeys?: string[] };
    githubRepoStatuses?: Record<string, number>;
  } = {},
) => {
  const githubRequests = installGitHubRepoStub(options.githubRepoStatuses);
  const { calls: jiraCalls } = await installJiraIssuesClientMock(options.jira);
  const { createApp } = await import("@scarn/api/app");
  const { createAppContext } = await import("@/lib/di");
  const apiClient = createScarnTreaty(
    createApp(
      createAppContext({ timeProvider: fixedTimeProvider(SECRETS_TEST_NOW) }),
    ),
  );

  const owner = await createSecretsTestUser();
  const teammate = await createSecretsTestUser();
  const project = await unwrapAsync(
    apiClient.api.projects.post(
      {
        name: "Auto-sync Project",
        description: "Project for auto-sync route tests",
        gitUrl: "https://github.com/example/test-project.git",
      },
      { headers: owner.authHeaders },
    ),
  );
  await getDb()
    .insert(projectMemberships)
    .values({
      projectId: project.id,
      userId: teammate.userId,
      role: "admin",
    });

  const projectApi = apiClient.api.projects({ projectId: project.id });

  const createIntegration = (body: Record<string, unknown>) =>
    unwrapAsync(
      projectApi.integrations.post(body, { headers: owner.authHeaders }),
    );

  const createSecret = (
    input: CreateSecretInput,
    headers: { authorization: string } = owner.authHeaders,
  ) => unwrapAsync(apiClient.api.me.secrets.post(input, { headers }));

  const enable = (
    integrationId: string,
    secretId: string,
    headers: { authorization: string } = owner.authHeaders,
  ) =>
    projectApi
      .integrations({ integrationId })
      ["auto-sync"].put({ secretId: parseUuidV7(secretId) }, { headers });

  const disable = (
    integrationId: string,
    headers: { authorization: string } = owner.authHeaders,
  ) =>
    projectApi.integrations({ integrationId })["auto-sync"].delete(undefined, {
      headers,
    });

  const loadIntegration = async (integrationId: string) => {
    const list = await unwrapAsync(
      projectApi.integrations.get({ headers: owner.authHeaders }),
    );
    return list.find((entry) => entry.id === integrationId);
  };

  return {
    apiClient,
    owner,
    teammate,
    project,
    jiraCalls,
    githubRequests,
    createIntegration,
    createSecret,
    enable,
    disable,
    loadIntegration,
  };
};
