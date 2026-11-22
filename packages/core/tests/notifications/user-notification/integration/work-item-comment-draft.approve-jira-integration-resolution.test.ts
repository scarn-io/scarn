import { afterEach, describe, expect, mock, test } from "bun:test";
import { fixedTimeProvider, unwrapAsync } from "tests/utils";
import { createScarnTreaty } from "tests/treaty";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { parseUuidV7, type UuidV7 } from "@/common/contracts/uuid-v7";
import {
  installJiraCommentClientMock,
  MOCKED_JIRA_COMMENT_ID,
  uninstallJiraCommentClientMock,
} from "./comment-draft-jira-fetch-support";
import {
  emitNotificationSignal,
  findPendingDraftByBody,
} from "./emit-notification-signal-support";

/**
 * Exercises Decision 2: a project may have more than one active Jira
 * integration (different Jira sites), and the correct one for a given draft
 * is resolved by deriving the work item's Jira project key from
 * `platformKey` and matching it against each active integration's
 * `externalScope.projectKeys` — never a bare "first Jira integration on this
 * project" pick, which could silently post to the wrong site.
 *
 * See `work-item-comment-draft.approve-jira.test.ts` for why `mock.module`
 * (rather than a faked `globalThis.fetch`) is used here, and why this file
 * uses plain serial `test`.
 */
describe("approve comment draft — Jira integration resolution", () => {
  afterEach(async () => {
    await uninstallJiraCommentClientMock();
    mock.restore();
  });

  const setUpApp = async () => {
    const { createApp } = await import("@scarn/api/app");
    const { createAppContext } = await import("@/lib/di");

    const NOW = new Date("2026-04-22T12:00:00.000Z");
    const app = createApp(
      createAppContext({ timeProvider: fixedTimeProvider(NOW) }),
    );
    return createScarnTreaty(app);
  };

  const createProjectWithTwoJiraIntegrations = async (
    apiClient: Awaited<ReturnType<typeof setUpApp>>,
    owner: { authHeaders: { authorization: string } },
    projectName: string,
  ) => {
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: projectName,
          description: `Project for ${projectName}`,
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    const alphaBaseUrl = "https://alpha.atlassian.net";
    const betaBaseUrl = "https://beta.atlassian.net";

    await unwrapAsync(
      apiClient.api.projects({ projectId: project.id }).integrations.post(
        {
          kind: "jira",
          externalScope: {
            baseUrl: alphaBaseUrl,
            projectKeys: ["ALPHA"],
          },
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    await unwrapAsync(
      apiClient.api.projects({ projectId: project.id }).integrations.post(
        {
          kind: "jira",
          externalScope: {
            baseUrl: betaBaseUrl,
            projectKeys: ["BETA"],
          },
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    return { project, alphaBaseUrl, betaBaseUrl };
  };

  const createJiraWorkItem = async (
    apiClient: Awaited<ReturnType<typeof setUpApp>>,
    owner: { authHeaders: { authorization: string } },
    projectId: UuidV7,
    platformKey: string,
  ) =>
    unwrapAsync(
      apiClient.api["work-items"].post(
        {
          projectId,
          platform: "jira",
          platformId: null,
          platformKey,
          url: null,
          title: `Jira issue ${platformKey}`,
          description: "Repro steps",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
          fields: null,
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

  test("resolves the integration whose projectKeys include the derived key, and posts using that integration's baseUrl", async () => {
    const { calls } = await installJiraCommentClientMock();
    const apiClient = await setUpApp();

    const owner = await createTestUserAndSession({
      email: `jira-resolution-match-${crypto.randomUUID()}@example.com`,
    });
    const { project, alphaBaseUrl } =
      await createProjectWithTwoJiraIntegrations(
        apiClient,
        owner,
        "Jira Resolution Match Project",
      );

    const workItem = await createJiraWorkItem(
      apiClient,
      owner,
      project.id,
      "ALPHA-123",
    );

    const draftBody = "Draft: resolution match.";
    await emitNotificationSignal({
      apiClient,
      authHeaders: owner.authHeaders,
      projectId: parseUuidV7(project.id),
      workItemId: parseUuidV7(workItem.id),
      items: [
        {
          kind: "status_update",
          body: draftBody,
          suggestedChannels: ["work_item_platform_comment"],
        },
      ],
    });
    const seededDraft = await findPendingDraftByBody(
      apiClient,
      owner.authHeaders,
      parseUuidV7(workItem.id),
      draftBody,
    );

    const comment = await unwrapAsync(
      apiClient.api["work-item-comment-drafts"]({
        notificationId: seededDraft.notification.id,
      }).approve.post(
        {
          body: "Resolved against the alpha site",
          credential: {
            email: "approver@acme.com",
            apiKey: "test-api-key",
          },
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    expect(comment.externalCommentId).toBe(MOCKED_JIRA_COMMENT_ID);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      baseUrl: alphaBaseUrl,
      email: "approver@acme.com",
      apiToken: "test-api-key",
      issueKey: "ALPHA-123",
    });
  });

  test("404s when the derived project key matches no active Jira integration", async () => {
    const { calls } = await installJiraCommentClientMock();
    const apiClient = await setUpApp();

    const owner = await createTestUserAndSession({
      email: `jira-resolution-notfound-${crypto.randomUUID()}@example.com`,
    });
    const { project } = await createProjectWithTwoJiraIntegrations(
      apiClient,
      owner,
      "Jira Resolution Notfound Project",
    );

    const workItem = await createJiraWorkItem(
      apiClient,
      owner,
      project.id,
      "GAMMA-1",
    );

    const draftBody = "Draft: resolution notfound.";
    await emitNotificationSignal({
      apiClient,
      authHeaders: owner.authHeaders,
      projectId: parseUuidV7(project.id),
      workItemId: parseUuidV7(workItem.id),
      items: [
        {
          kind: "status_update",
          body: draftBody,
          suggestedChannels: ["work_item_platform_comment"],
        },
      ],
    });
    const seededDraft = await findPendingDraftByBody(
      apiClient,
      owner.authHeaders,
      parseUuidV7(workItem.id),
      draftBody,
    );

    const { data, error } = await apiClient.api["work-item-comment-drafts"]({
      notificationId: seededDraft.notification.id,
    }).approve.post(
      {
        body: "No integration should match this",
        credential: { email: "approver@acme.com", apiKey: "test-api-key" },
      },
      { headers: { ...owner.authHeaders } },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(404);
    expect(error?.value).toMatchObject({
      code: "JIRA_PROJECT_INTEGRATION_NOT_FOUND",
    });
    expect(calls).toHaveLength(0);
  });

  test("422s when the derived project key matches more than one active Jira integration", async () => {
    const { calls } = await installJiraCommentClientMock();
    const apiClient = await setUpApp();

    const owner = await createTestUserAndSession({
      email: `jira-resolution-ambiguous-${crypto.randomUUID()}@example.com`,
    });
    const { project } = await createProjectWithTwoJiraIntegrations(
      apiClient,
      owner,
      "Jira Resolution Ambiguous Project",
    );

    // A third, distinct-site integration whose `projectKeys` overlaps the
    // first ("ALPHA") integration's — two active Jira integrations on this
    // project now both claim ownership of the "ALPHA" project key.
    const gammaBaseUrl = "https://alpha-2.atlassian.net";
    await unwrapAsync(
      apiClient.api.projects({ projectId: project.id }).integrations.post(
        {
          kind: "jira",
          externalScope: {
            baseUrl: gammaBaseUrl,
            projectKeys: ["ALPHA"],
          },
        },
        { headers: { ...owner.authHeaders } },
      ),
    );

    const workItem = await createJiraWorkItem(
      apiClient,
      owner,
      project.id,
      "ALPHA-999",
    );

    const draftBody = "Draft: resolution ambiguous.";
    await emitNotificationSignal({
      apiClient,
      authHeaders: owner.authHeaders,
      projectId: parseUuidV7(project.id),
      workItemId: parseUuidV7(workItem.id),
      items: [
        {
          kind: "status_update",
          body: draftBody,
          suggestedChannels: ["work_item_platform_comment"],
        },
      ],
    });
    const seededDraft = await findPendingDraftByBody(
      apiClient,
      owner.authHeaders,
      parseUuidV7(workItem.id),
      draftBody,
    );

    const { data, error } = await apiClient.api["work-item-comment-drafts"]({
      notificationId: seededDraft.notification.id,
    }).approve.post(
      {
        body: "Two integrations should match this",
        credential: { email: "approver@acme.com", apiKey: "test-api-key" },
      },
      { headers: { ...owner.authHeaders } },
    );

    expect(data).toBeNull();
    expect(error?.status).toBe(422);
    expect(error?.value).toMatchObject({
      code: "WORK_ITEM_JIRA_INTEGRATION_AMBIGUOUS",
    });
    expect(calls).toHaveLength(0);
  });
});
