import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import { createApp } from "@scarn/api/app";
import type { AnyJsonValue } from "@scarn/core/common/contracts/json";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import type { TimeProvider } from "@/lib/time-provider";
import type { ObjectStore } from "@/artifacts/object-store";
import type { WorkNotifier } from "@/tasks/task-run/application/work-notifier";
import type { AnalyticsPort } from "@/lib/analytics/analytics-port";
import { unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import {
  buildAgentStepDefinitionPayload,
  createPipelineFromDocument,
} from "tests/pipeline-definitions/pipeline-test-support";
import { createTestWorkItem } from "tests/tasks/task-run/integration/task-run-test-support";

export type Claim = { taskId: UuidV7; claimToken: string };

/** A Notion search tool call, as an `mcp_tool` step's `toolCallJson`. */
export const mcpToolCallFixture = {
  server: "notion",
  tool: "search",
  argsTemplate: { query: "{{input.query}}", limit: 5 },
  toolSchemas: {
    input: { type: "object" },
    output: { type: "object", properties: { hits: { type: "array" } } },
  },
};

export type McpToolCallFixture = typeof mcpToolCallFixture;

/**
 * One app over a movable clock, a project, and an agent step definition, plus
 * the calls a pipeline-run test makes through the API: start a run, claim
 * its Tasks, report results and read the run back.
 */
export const createPipelineRunHarness = (
  name: string,
  {
    objectStore,
    workNotifier,
    analytics,
  }: {
    objectStore?: ObjectStore | undefined;
    workNotifier?: WorkNotifier | undefined;
    analytics?: AnalyticsPort | undefined;
  } = {},
) => {
  let currentTime = new Date("2026-06-01T09:00:00.000Z");
  const timeProvider: TimeProvider = {
    now: () => currentTime,
    nowIso: () => currentTime.toISOString(),
  };
  const appContext = createAppContext({
    timeProvider,
    ...(objectStore ? { objectStore } : {}),
    ...(workNotifier ? { workNotifier } : {}),
    ...(analytics ? { analytics } : {}),
  });
  const app = createApp(appContext);
  const apiClient = createScarnTreaty(app);
  let setup:
    | {
        projectId: UuidV7;
        userId: UuidV7;
        stepKey: string;
        headers: { authorization: string };
      }
    | undefined;

  const requireSetup = () => {
    if (!setup) {
      throw new Error("Expected setup to complete");
    }
    return { ...setup, headers: { ...setup.headers } };
  };

  const setUp = async () => {
    const owner = await createTestUserAndSession({
      email: `${name}-${crypto.randomUUID()}@example.com`,
    });
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: `${name} project`,
          description: `Project for ${name} tests`,
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    const projectId = parseUuidV7(project.id);
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        buildAgentStepDefinitionPayload(projectId),
        { headers: { ...owner.authHeaders } },
      ),
    );
    setup = {
      projectId,
      userId: parseUuidV7(owner.userId),
      stepKey: stepDefinition.key,
      headers: owner.authHeaders,
    };
  };

  const setTime = (iso: string) => {
    currentTime = new Date(iso);
  };

  const uniqueKey = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

  const startRun = async (document: PipelineDocument) => {
    const { projectId, headers } = requireSetup();
    const definition = await createPipelineFromDocument(
      apiClient,
      headers,
      projectId,
      document,
    );
    const workItem = await createTestWorkItem(
      apiClient,
      headers,
      projectId,
      name,
    );
    const execution = await unwrapAsync(
      apiClient.api["pipeline-executions"].post(
        {
          projectId,
          workItemId: parseUuidV7(workItem.id),
          pipelineDefinitionId: parseUuidV7(definition.id),
        },
        { headers },
      ),
    );
    return { execution, executionId: execution.id, workItemId: workItem.id };
  };

  const getRun = async (executionId: UuidV7) =>
    await unwrapAsync(
      apiClient.api["pipeline-executions"]({
        pipelineExecutionId: executionId,
      }).get({ headers: requireSetup().headers }),
    );

  const getTaskRun = async (taskId: UuidV7) =>
    await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId: taskId }).get({
        headers: requireSetup().headers,
      }),
    );

  const claim = async (
    workItemId: string,
    { batchSize = 1, leaseDurationSeconds = 30 } = {},
  ): Promise<Claim[]> => {
    const { projectId, headers } = requireSetup();
    const claims = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workerId: `${name}-worker`,
          batchSize,
          leaseDurationSeconds,
          workItemId,
        },
        { headers },
      ),
    );
    return claims.map((item) => ({
      taskId: item.task.id,
      claimToken: item.claimToken,
    }));
  };

  const claimOne = async (workItemId: string, leaseDurationSeconds = 30) => {
    const [claimed] = await claim(workItemId, { leaseDurationSeconds });
    if (!claimed) {
      throw new Error("Expected a claim");
    }
    return claimed;
  };

  const complete = async (
    claimed: Claim,
    status: "succeeded" | "failed",
    resultJson: AnyJsonValue = { status: "completed" },
    errorJson: AnyJsonValue | null = null,
  ) =>
    await unwrapAsync(
      apiClient.api["task-runs"]({
        taskRunId: claimed.taskId,
      }).completions.post(
        { claimToken: claimed.claimToken, status, resultJson, errorJson },
        { headers: requireSetup().headers },
      ),
    );

  /** The newest visit to `nodeId` that wasn't superseded. */
  const visitOf = (
    execution: Awaited<ReturnType<typeof getRun>>,
    nodeId: string,
  ) => {
    const visit = execution.visits
      .filter((item) => item.nodeId === nodeId && item.status !== "superseded")
      .at(-1);
    if (!visit) {
      throw new Error(`Expected a visit to ${nodeId}`);
    }
    return visit;
  };

  const visitRoutes = (executionId: UuidV7, visitId: UuidV7) =>
    apiClient.api["pipeline-executions"]({
      pipelineExecutionId: executionId,
    }).visits({ visitId });

  /** An `mcp_tool` step definition in the harness project calling `toolCallJson`. */
  const createMcpToolStep = async (
    toolCallJson: McpToolCallFixture = mcpToolCallFixture,
  ) => {
    const { projectId, headers } = requireSetup();
    return await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          projectId,
          key: uniqueKey(`${toolCallJson.server}-${toolCallJson.tool}`),
          name: "MCP tool step",
          description: null,
          prompt: null,
          version: 1,
          kind: "mcp_tool",
          toolCallJson,
          inputSchemaJson: { type: "object" },
          resultSchemaJson: toolCallJson.toolSchemas.output,
          opencodeMcpJson: {
            [toolCallJson.server]: {
              type: "remote",
              url: "https://mcp.notion.com/mcp",
            },
          },
          status: "active",
        },
        { headers },
      ),
    );
  };

  return {
    appContext,
    apiClient,
    setUp,
    requireSetup,
    setTime,
    uniqueKey,
    startRun,
    getRun,
    getTaskRun,
    claim,
    claimOne,
    complete,
    visitOf,
    visitRoutes,
    createMcpToolStep,
  };
};
