/**
 * A `code` step may declare MCP servers so its function can call their
 * tools. Its health checks may only be `tool` checks on those servers. The
 * servers and checks reach the worker unchanged for the step's Tasks.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnApiClient } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import {
  fixedTimeProvider,
  unwrapAsync,
  unwrapStartedTaskAsync,
} from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

const notionServers = {
  notion: { type: "ref", auth: { connection: "notion" } },
} as const;

const notionSearchCheck = {
  kind: "tool",
  tool: "search",
  mcp: "notion",
  severity: "required",
  timeoutSeconds: 15,
} as const;

describe("code step definitions with MCP servers", () => {
  let apiClient: ReturnType<typeof createScarnApiClient>;
  let projectId: UuidV7;
  let headers: { authorization: string };

  const codeStepPayload = (
    healthChecksJson: readonly object[] = [notionSearchCheck],
  ) => ({
    projectId,
    key: `code_mcps_${crypto.randomUUID()}`,
    name: "Notion sync",
    description: null,
    version: 1,
    kind: "code" as const,
    entrypointJson: { sourceFile: ".scarn/steps/notion-sync.ts" },
    environment: {
      kind: "inline" as const,
      runtime: { kind: "managed" as const, id: "bun1" as const },
    },
    inputSchemaJson: { type: "object" },
    resultSchemaJson: { type: "object" },
    opencodeMcpJson: notionServers as never,
    healthChecksJson: healthChecksJson as never,
    status: "active" as const,
  });

  const putFailure = async (payload: ReturnType<typeof codeStepPayload>) => {
    const response = await apiClient.api["step-definitions"].put(payload, {
      headers,
    });
    return { status: response.status, body: JSON.stringify(response.error) };
  };

  beforeAll(async () => {
    const app = createApp(
      createAppContext({
        timeProvider: fixedTimeProvider(new Date("2026-11-22T12:00:00.000Z")),
      }),
    );
    apiClient = createScarnApiClient(app);
    const owner = await createTestUserAndSession({
      email: `step-definition-code-mcps-${crypto.randomUUID()}@example.com`,
    });
    headers = owner.authHeaders;
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Code MCPs Project",
          description: "Project for code steps with MCP servers",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers },
      ),
    );
    projectId = parseUuidV7(project.id);
  });

  test("a pushed code step's servers and checks reach the worker context", async () => {
    const step = await unwrapAsync(
      apiClient.api["step-definitions"].put(codeStepPayload(), { headers }),
    );
    expect({
      kind: step.kind,
      opencodeMcpJson: step.opencodeMcpJson,
      healthChecksJson: step.healthChecksJson,
    }).toEqual({
      kind: "code",
      opencodeMcpJson: notionServers,
      healthChecksJson: [notionSearchCheck],
    });

    const { run } = await unwrapStartedTaskAsync(
      apiClient.api.tasks.post(
        {
          projectId,
          workItemId: await seedWorkItem(projectId),
          stepDefinitionId: step.id,
          stepDefinitionVersion: 1,
          inputJson: {},
          executionTimeoutSeconds: 180,
        },
        { headers },
      ),
    );
    const [claim] = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workerId: `worker-code-mcps-${crypto.randomUUID()}`,
          batchSize: 1,
          leaseDurationSeconds: 30,
        },
        { headers },
      ),
    );
    if (!claim) throw new Error("Expected the code Task to be claimed");

    const workerContext = await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId: run.id })["worker-context"].post(
        { claimToken: claim.claimToken },
        { headers },
      ),
    );
    expect({
      kind: workerContext.task.kind,
      opencodeMcpJson: workerContext.runtime.opencodeMcpJson,
      healthChecksJson: workerContext.runtime.healthChecksJson,
    }).toEqual({
      kind: "code",
      opencodeMcpJson: notionServers,
      healthChecksJson: [notionSearchCheck],
    });
  });

  test.each([
    ["a cli check", { kind: "cli", command: ["true"] }],
    ["a tool check with no MCP server", { kind: "tool", tool: "read" }],
  ])("rejects a code step with %s", async (_label, check) => {
    const failure = await putFailure(
      codeStepPayload([notionSearchCheck, check]),
    );
    expect(failure.status).toBe(422);
    expect(failure.body).toContain(
      "allows only 'tool' health checks that name one of its MCP servers",
    );
  });

  test("rejects a code step's tool check on a server it doesn't declare", async () => {
    const failure = await putFailure(
      codeStepPayload([{ ...notionSearchCheck, mcp: "github" }]),
    );
    expect(failure.status).toBe(422);
    expect(failure.body).toContain(
      "TASK_EXECUTION_CONFIG_HEALTH_CHECK_MCP_UNKNOWN",
    );
  });
});
