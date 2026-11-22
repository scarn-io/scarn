import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { parseUuidV7 } from "@/common/contracts/uuid-v7";
import { parseWorkItemId } from "@/work-items/work-item/domain/work-item-id";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { unwrapAsync } from "tests/utils";
import {
  createRelationshipsTestHarness,
  makeRelationshipsFetchImpl,
  useGithubRelationshipsTestEnv,
} from "./run-project-integration-sync-relationships-test-support";

const WEBHOOK_SECRET = "test-github-webhook-secret-ready-work";

/**
 * A GitHub close, whether it arrives by sync or by webhook, unblocks the
 * dependent item and gives its waiting Task a run. Reassigns
 * `globalThis.fetch` and `process.env`, so tests run serially.
 */
describe("GitHub close starts ready work", () => {
  useGithubRelationshipsTestEnv();
  const {
    app,
    apiClient,
    createProjectWithGitHubIntegration,
    runSync,
    loadSyncedWorkItem,
  } = createRelationshipsTestHarness();

  let originalWebhookSecret: string | undefined;
  beforeEach(() => {
    originalWebhookSecret = process.env["GITHUB_APP_WEBHOOK_SECRET"];
    process.env["GITHUB_APP_WEBHOOK_SECRET"] = WEBHOOK_SECRET;
  });
  afterEach(() => {
    if (originalWebhookSecret === undefined) {
      Reflect.deleteProperty(process.env, "GITHUB_APP_WEBHOOK_SECRET");
    } else {
      process.env["GITHUB_APP_WEBHOOK_SECRET"] = originalWebhookSecret;
    }
  });

  const startTask = async (
    projectId: string,
    workItemId: string,
    headers: { authorization: string },
  ) => {
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId: parseUuidV7(projectId),
          key: `github_ready_${crypto.randomUUID()}`,
          name: "Ready work step",
          description: "Step started on a blocked GitHub issue",
          prompt: "Return a result payload.",
          version: 1,
          kind: "user_defined",
          inputSchemaJson: { type: "object" },
          resultSchemaJson: { type: "object" },
          status: "active",
          repo: { mode: "readOnly" },
        },
        { headers },
      ),
    );
    const created = await unwrapAsync(
      apiClient.api.tasks.post(
        {
          projectId: parseUuidV7(projectId),
          workItemId: parseUuidV7(workItemId),
          stepDefinitionId: stepDefinition.id,
          stepDefinitionVersion: stepDefinition.version,
          inputJson: null,
        },
        { headers },
      ),
    );
    expect(created.task.status).toBe("waiting_for_work");
    expect(created.run).toBeNull();
    return created.task.id;
  };

  const loadRuns = async (taskId: string, headers: { authorization: string }) =>
    await unwrapAsync(apiClient.api.tasks({ taskId }).runs.get({ headers }));

  const expectStarted = async (
    taskId: string,
    headers: { authorization: string },
  ) => {
    const task = await unwrapAsync(
      apiClient.api.tasks({ taskId }).get({ headers }),
    );
    expect(task.status).toBe("queued");
    expect(
      (await loadRuns(taskId, headers)).map(({ number, reason }) => ({
        number,
        reason,
      })),
    ).toEqual([{ number: 1, reason: "initial" }]);
  };

  test.serial(
    "a sync that reports the blocker closed gives the waiting Task its run",
    async () => {
      const owner = await createTestUserAndSession({
        email: `github-ready-sync-${crypto.randomUUID()}@example.com`,
      });
      const repoFullName = "acme/ready-sync";
      const { project, integrationId } =
        await createProjectWithGitHubIntegration(
          owner,
          "GitHub Ready Sync",
          repoFullName,
        );
      const blockedBy = {
        1: [{ owner: "acme", repo: "ready-sync", number: 2 }],
      };

      globalThis.fetch = makeRelationshipsFetchImpl({
        repoFullName,
        issues: [{ number: 1 }, { number: 2 }],
        blockedByByNumber: blockedBy,
      });
      await runSync(project.id, integrationId, owner.authHeaders);
      const blocked = await loadSyncedWorkItem(project.id, repoFullName, 1);
      const taskId = await startTask(project.id, blocked.id, owner.authHeaders);

      globalThis.fetch = makeRelationshipsFetchImpl({
        repoFullName,
        issues: [{ number: 1 }, { number: 2, state: "closed" }],
        blockedByByNumber: blockedBy,
      });
      await runSync(project.id, integrationId, owner.authHeaders);

      await expectStarted(taskId, owner.authHeaders);
    },
  );

  test.serial(
    "an issues.closed webhook for the blocker gives the waiting Task its run",
    async () => {
      const owner = await createTestUserAndSession({
        email: `github-ready-webhook-${crypto.randomUUID()}@example.com`,
      });
      const repoFullName = "acme/ready-webhook";
      const installationId = Math.floor(Math.random() * 1_000_000_000) + 1;
      const repositoryId = Math.floor(Math.random() * 1_000_000_000) + 1;
      const project = await unwrapAsync(
        apiClient.api.projects.post(
          {
            name: "GitHub Ready Webhook",
            description: "Project for the webhook readiness test",
            gitUrl: "https://github.com/example/test-project.git",
          },
          { headers: { ...owner.authHeaders } },
        ),
      );
      await unwrapAsync(
        apiClient.api.projects({ projectId: project.id }).integrations.post(
          {
            kind: "github_app",
            installationId: String(installationId),
            externalScope: {
              repos: [{ id: repositoryId, fullName: repoFullName }],
            },
          },
          { headers: { ...owner.authHeaders } },
        ),
      );

      const deliver = async (
        number: number,
        action: "opened" | "closed",
        updatedAt: string,
      ) => {
        const rawBody = JSON.stringify({
          action,
          installation: { id: installationId },
          repository: { id: repositoryId, full_name: repoFullName },
          issue: {
            id: number,
            node_id: `I_${String(number)}`,
            number,
            title: `Issue ${String(number)}`,
            body: "Repro",
            html_url: `https://github.com/${repoFullName}/issues/${String(number)}`,
            state: action === "closed" ? "closed" : "open",
            state_reason: action === "closed" ? "completed" : null,
            user: { login: "alice" },
            labels: [],
            assignees: [],
            comments: 0,
            created_at: "2026-04-01T00:00:00Z",
            updated_at: updatedAt,
            closed_at: action === "closed" ? updatedAt : null,
          },
        });
        const signature = createHmac("sha256", WEBHOOK_SECRET)
          .update(rawBody)
          .digest("hex");
        const response = await app.handle(
          new Request("http://localhost/api/integrations/github/webhook", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-github-event": "issues",
              "x-hub-signature-256": `sha256=${signature}`,
            },
            body: rawBody,
          }),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, applied: true });
      };

      await deliver(1, "opened", "2026-04-01T00:00:00Z");
      await deliver(2, "opened", "2026-04-01T00:00:00Z");
      const blocked = await loadSyncedWorkItem(project.id, repoFullName, 1);
      const blocker = await loadSyncedWorkItem(project.id, repoFullName, 2);
      await unwrapAsync(
        apiClient.api["work-item-blocks"].post(
          {
            blockedWorkItemId: parseWorkItemId(blocked.id),
            blockingWorkItemId: parseWorkItemId(blocker.id),
          },
          { headers: { ...owner.authHeaders } },
        ),
      );
      const taskId = await startTask(project.id, blocked.id, owner.authHeaders);

      await deliver(2, "closed", "2026-04-02T00:00:00Z");

      expect(
        (await loadSyncedWorkItem(project.id, repoFullName, 2)).state,
      ).toBe("closed");
      await expectStarted(taskId, owner.authHeaders);
    },
  );
});
