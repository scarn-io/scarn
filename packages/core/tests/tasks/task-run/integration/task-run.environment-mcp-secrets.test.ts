import { beforeAll, describe, expect } from "bun:test";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { OpenCodeMcpServers } from "@scarn/core/common/contracts/opencode-mcp";
import type { TimeProvider } from "@/lib/time-provider";
import { serialTest, unwrapAsync, unwrapStartedTaskAsync } from "tests/utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";
import { createSecretsTestClient } from "tests/secrets/secret/integration/secret-test-support";
import {
  createProjectSecretsTestProject,
  createProjectSecretsTestUser,
  projectSecretValue,
  type ProjectSecretsTestUser,
} from "tests/secrets/secret/integration/project-secret-test-support";
import { buildStepDefinitionPayload } from "./task-run-test-support";

/**
 * A project secret an MCP server's `workerVars` names is released to the
 * worker holding the claim, the same as one the step's environment names.
 */
describe("task run environment secrets: MCP workerVars", () => {
  const currentTime = new Date("2026-05-03T12:00:00.000Z");
  const timeProvider: TimeProvider = {
    now: () => currentTime,
    nowIso: () => currentTime.toISOString(),
  };
  const apiClient = createSecretsTestClient(timeProvider);
  let owner: ProjectSecretsTestUser;

  beforeAll(async () => {
    owner = await createProjectSecretsTestUser("env-mcp-owner");
  });

  const startAndClaim = async (
    projectId: UuidV7,
    opencodeMcpJson: OpenCodeMcpServers,
  ) => {
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          ...buildStepDefinitionPayload(
            projectId,
            `env_mcp_step_${crypto.randomUUID()}`,
          ),
          environment: { kind: "inline", envJson: [] },
          opencodeMcpJson,
        },
        { headers: owner.authHeaders },
      ),
    );
    await unwrapStartedTaskAsync(
      apiClient.api.tasks.post(
        {
          projectId,
          workItemId: await seedWorkItem(projectId),
          stepDefinitionId: stepDefinition.id,
          stepDefinitionVersion: 1,
          inputJson: {},
          executionTimeoutSeconds: 600,
        },
        { headers: owner.authHeaders },
      ),
    );
    const [claim] = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workerId: "env-mcp-worker",
          batchSize: 1,
          leaseDurationSeconds: 30,
        },
        { headers: owner.authHeaders },
      ),
    );
    if (!claim) throw new Error("Expected a claim");
    return {
      taskRunId: parseUuidV7(claim.task.id),
      claimToken: claim.claimToken,
    };
  };

  serialTest("returns a secret an MCP server's workerVars name", async () => {
    const projectId = await createProjectSecretsTestProject(apiClient, owner);
    const value = projectSecretValue();
    await unwrapAsync(
      apiClient.api
        .projects({ projectId })
        .secrets.post(
          { name: "JIRA_TOKEN", value },
          { headers: owner.authHeaders },
        ),
    );
    const { taskRunId, claimToken } = await startAndClaim(projectId, {
      atlassian: {
        type: "remote",
        url: "https://mcp.atlassian.com/v2/mcp",
        headers: { Authorization: "Basic {basic:JIRA_EMAIL:JIRA_API_TOKEN}" },
        workerVars: [
          {
            name: "JIRA_EMAIL",
            source: "value",
            value: "bot@acme.com",
            secret: false,
            applies: "agent",
          },
          {
            name: "JIRA_API_TOKEN",
            source: "secret",
            secretName: "JIRA_TOKEN",
            applies: "agent",
          },
        ],
      },
    });

    const environment = await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId }).environment.post(
        { claimToken, secretNames: ["JIRA_TOKEN"] },
        { headers: owner.authHeaders },
      ),
    );
    expect(environment).toEqual({
      secrets: { JIRA_TOKEN: { value, expiresAt: null } },
      missing: [],
    });
  });

  serialTest(
    "still rejects a name no server or environment names",
    async () => {
      const projectId = await createProjectSecretsTestProject(apiClient, owner);
      const { taskRunId, claimToken } = await startAndClaim(projectId, {
        atlassian: {
          type: "remote",
          url: "https://mcp.atlassian.com/v2/mcp",
          headers: { Authorization: "Bearer {env:TOKEN}" },
          workerVars: [
            {
              name: "TOKEN",
              source: "secret",
              secretName: "JIRA_TOKEN",
              applies: "agent",
            },
          ],
        },
      });

      const { error } = await apiClient.api["task-runs"]({
        taskRunId,
      }).environment.post(
        { claimToken, secretNames: ["OTHER_SECRET"] },
        { headers: owner.authHeaders },
      );
      expect(error?.status).toBe(403);
    },
  );
});
