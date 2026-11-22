/* eslint-disable max-lines */
import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { eq } from "drizzle-orm";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { getDb } from "@/lib/db";
import { taskRuns, tasks } from "@/lib/db/schema";
import type { TimeProvider } from "@/lib/time-provider";
import type { ProjectContract } from "@/projects/project/contracts/project-contracts";
import { serialTest, unwrapAsync, unwrapStartedTaskAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import {
  buildStepDefinitionPayload,
  createSingleStepPipelineDefinition,
  createTestWorkItem,
} from "./task-run-test-support";
import {
  createPipelineFromDocument,
  latestTaskIdForNode,
} from "tests/pipeline-definitions/pipeline-test-support";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

const buildCodeStepDefinitionPayload = (projectId: UuidV7, key: string) => ({
  projectId,
  key,
  name: "Claimable code step",
  description: "Reusable kind: 'code' step for worker-context tests",
  version: 1,
  kind: "code" as const,
  entrypointJson: {
    sourceFile: ".scarn/pipeline-builder/review-file-step.ts",
  },
  inputSchemaJson: {
    type: "object",
  },
  resultSchemaJson: {
    type: "object",
  },
  status: "active" as const,
});

const toIsoString = (value: Date | string | null) =>
  value instanceof Date ? value.toISOString() : value;

/**
 * A graph-shape pipeline whose single entry `step` node advances (via the
 * default auto-continue advancement policy) into a `parallel` node with two
 * named branches. Completing the entry step's claimed execution creates
 * both branches' `NodeRun`s `queued` simultaneously, in the SAME pipeline
 * run/attempt — Phase 4's target scenario
 * (`docs/plans/claim-step-executions-batching.md`): two nodes of one
 * attempt becoming claimable together, the case grouping-by-`pipelineRunId`
 * exists to keep safe.
 */
const createParallelBranchPipelineDefinition = async (
  apiClient: ReturnType<typeof createScarnTreaty>,
  authHeaders: { authorization: string },
  projectId: UuidV7,
  stepKey: string,
) => {
  const definition = await createPipelineFromDocument(
    apiClient,
    authHeaders,
    projectId,
    {
      schemaVersion: 1,
      key: `claim-parallel-pipeline-${crypto.randomUUID()}`,
      start: { to: "entry" },
      nodes: {
        entry: {
          kind: "step",
          step: stepKey,
          next: {
            routes: [
              {
                to: "branch",
                each: { over: "result.branches" },
                args: { branch: "item" },
              },
            ],
          },
        },
        branch: {
          kind: "step",
          step: stepKey,
          next: {
            routes: [{ to: "done" }],
          },
        },
        done: { kind: "succeed" },
      },
    },
    "Claim parallel-lane pipeline",
  );
  return { ...definition, id: parseUuidV7(definition.id) };
};

describe("task claims", () => {
  let currentTime = new Date("2026-04-28T12:00:00.000Z");
  const timeProvider: TimeProvider = {
    now: () => currentTime,
    nowIso: () => currentTime.toISOString(),
  };
  const app = createApp(createAppContext({ timeProvider }));
  const apiClient = createScarnTreaty(app);
  let project: ProjectContract | undefined;
  let authHeaders: { authorization: string } | undefined;
  let ownerUserId: string | undefined;
  let stepDefinitionId: UuidV7 | undefined;
  let stepKey: string | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `task-claims-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    ownerUserId = owner.userId;
    project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Task Claims Project",
          description: "Project for task claim tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        {
          headers: { ...owner.authHeaders },
        },
      ),
    );

    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        buildStepDefinitionPayload(
          parseUuidV7(project.id),
          `claim_step_${crypto.randomUUID()}`,
        ),
        { headers: { ...owner.authHeaders } },
      ),
    );
    stepDefinitionId = stepDefinition.id;
    stepKey = stepDefinition.key;
  });

  serialTest(
    "claims, heartbeats, and completes a standalone task",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId || !stepKey) {
        throw new Error("Expected setup to complete");
      }

      currentTime = new Date("2026-04-28T12:00:00.000Z");
      const { run: task } = await unwrapStartedTaskAsync(
        apiClient.api.tasks.post(
          {
            projectId: parseUuidV7(project.id),
            workItemId: await seedWorkItem(parseUuidV7(project.id)),
            stepDefinitionId,
            stepDefinitionVersion: 1,
            inputJson: { ticketId: "ticket-1" },
            executionTimeoutSeconds: 120,
          },
          { headers: { ...authHeaders } },
        ),
      );

      const claims = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId: parseUuidV7(project.id),
            workerId: "worker-a",
            batchSize: 1,
            leaseDurationSeconds: 30,
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({
        task: {
          id: task.id,
          status: "running",
          claimedBy: "worker-a",
          executionTimeoutSeconds: 120,
        },
      });

      const claimToken = claims[0]?.claimToken;
      if (!claimToken) {
        throw new Error("Expected claim token to be returned");
      }

      const claimedByUserIdOf = async () => {
        const [row] = await getDb()
          .select({ claimedByUserId: taskRuns.claimedByUserId })
          .from(taskRuns)
          .where(eq(taskRuns.id, task.id));
        return row?.claimedByUserId;
      };
      expect(await claimedByUserIdOf()).toBe(ownerUserId);

      currentTime = new Date("2026-04-28T12:00:10.000Z");
      const heartbeatedExecution = await unwrapAsync(
        apiClient.api["task-runs"]({
          taskRunId: task.id,
        }).heartbeat.put(
          {
            claimToken,
            leaseDurationSeconds: 30,
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(toIsoString(heartbeatedExecution.lastHeartbeatAt)).toBe(
        "2026-04-28T12:00:10.000Z",
      );
      expect(toIsoString(heartbeatedExecution.leaseExpiresAt)).toBe(
        "2026-04-28T12:00:40.000Z",
      );

      currentTime = new Date("2026-04-28T12:00:20.000Z");
      const completedExecution = await unwrapAsync(
        apiClient.api["task-runs"]({
          taskRunId: task.id,
        }).completions.post(
          {
            claimToken,
            status: "succeeded",
            resultJson: { status: "completed", payload: { ok: true } },
            errorJson: null,
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(completedExecution.id).toBe(task.id);
      expect(completedExecution.status).toBe("succeeded");
      expect(completedExecution.claimedBy).toBeNull();
      expect(await claimedByUserIdOf()).toBeNull();
      expect(toIsoString(completedExecution.completedAt)).toBe(
        "2026-04-28T12:00:20.000Z",
      );

      const persistedExecution = await unwrapAsync(
        apiClient.api["task-runs"]({
          taskRunId: task.id,
        }).get({
          headers: { ...authHeaders },
        }),
      );

      expect(persistedExecution.status).toBe("succeeded");
      expect(persistedExecution.resultJson).toEqual({
        status: "completed",
        payload: { ok: true },
      });
    },
  );

  serialTest(
    "returns worker context for an actively claimed standalone task, named after its step",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId || !stepKey) {
        throw new Error("Expected setup to complete");
      }

      currentTime = new Date("2026-04-28T12:30:00.000Z");
      const { run: task } = await unwrapStartedTaskAsync(
        apiClient.api.tasks.post(
          {
            projectId: parseUuidV7(project.id),
            workItemId: await seedWorkItem(parseUuidV7(project.id)),
            stepDefinitionId,
            stepDefinitionVersion: 1,
            inputJson: { ticketId: "ticket-worker-context", priority: "high" },
            executionTimeoutSeconds: 180,
          },
          { headers: { ...authHeaders } },
        ),
      );

      const claims = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId: parseUuidV7(project.id),
            workerId: "worker-context",
            batchSize: 1,
            leaseDurationSeconds: 30,
          },
          { headers: { ...authHeaders } },
        ),
      );
      const claimToken = claims[0]?.claimToken;

      if (!claimToken) {
        throw new Error("Expected claim token to be returned");
      }

      const workerContext = await unwrapAsync(
        apiClient.api["task-runs"]({
          taskRunId: task.id,
        })["worker-context"].post(
          {
            claimToken,
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(workerContext.projectPath).toMatch(
        new RegExp(`^[^/]+/${project.slug}$`),
      );
      expect(workerContext).toMatchObject({
        projectId: project.id,
        gitUrl: "https://github.com/example/test-project.git",
        task: {
          id: task.id,
          status: "running",
          kind: "agent",
          inputJson: { ticketId: "ticket-worker-context", priority: "high" },
          executionTimeoutSeconds: 180,
          prompt: "Return a result payload.",
        },
        runtime: {
          opencodeMcpJson: {
            playwright: {
              type: "local",
              command: ["npx", "-y", "@playwright/mcp@0.0.68"],
              disabled: false,
            },
          },
          environment: {
            kind: "inline",
            runtime: {
              kind: "devcontainer",
              config: ".devcontainer/alt/devcontainer.json",
            },
            envJson: [
              {
                name: "ACCOUNT_ID",
                source: "value" as const,
                value: "{{input.accountId}}",
                secret: false,
                applies: "agent" as const,
              },
            ],
          },
          repo: {
            mode: "readWrite",
            message: "fix: {{result.summary}}",
            onPushFailure: "warn",
          },
        },
      });
      expect(workerContext.task.name).toBe("Claimable step");
      expect(workerContext.task.key).toBe(task.id);
      expect(workerContext.agentPrompt.sessionTitle).toBe(
        `Claimable step (${task.id})`,
      );
      expect(workerContext.agentPrompt.promptText).not.toContain("Step key:");
      expect(workerContext.agentPrompt.promptText).toContain(
        `Task run id: ${task.id}\nWork item id: ${workerContext.task.workItemId ?? ""}\n`,
      );
      expect(workerContext.agentPrompt.promptText).toContain(
        '"ticketId": "ticket-worker-context"',
      );
      expect(workerContext.agentPrompt.promptText).toContain(
        ".scarn/current-execution/execution.json",
      );
      expect(workerContext.agentPrompt.promptText).not.toContain(
        "Expected findings result schema JSON",
      );
    },
  );

  serialTest(
    "returns worker context for a claimed 'code' kind task, with kind/entrypointJson surfaced and prompt null",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected setup to complete");
      }

      const codeStepDefinition = await unwrapAsync(
        apiClient.api["step-definitions"].post(
          {
            ...buildCodeStepDefinitionPayload(
              parseUuidV7(project.id),
              `claim_code_step_${crypto.randomUUID()}`,
            ),
            environment: {
              kind: "inline",
              runtime: { kind: "managed", id: "bun1" },
            },
          },
          { headers: { ...authHeaders } },
        ),
      );

      currentTime = new Date("2026-04-28T12:45:00.000Z");
      const { run: task } = await unwrapStartedTaskAsync(
        apiClient.api.tasks.post(
          {
            projectId: parseUuidV7(project.id),
            workItemId: await seedWorkItem(parseUuidV7(project.id)),
            stepDefinitionId: codeStepDefinition.id,
            stepDefinitionVersion: 1,
            inputJson: { file: "src/index.ts" },
            executionTimeoutSeconds: 180,
          },
          { headers: { ...authHeaders } },
        ),
      );

      const claims = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId: parseUuidV7(project.id),
            workerId: "worker-code-step",
            batchSize: 1,
            leaseDurationSeconds: 30,
          },
          { headers: { ...authHeaders } },
        ),
      );
      const claimToken = claims[0]?.claimToken;

      if (!claimToken) {
        throw new Error("Expected claim token to be returned");
      }

      // Confirmed by prior audit: `kind === "code"` steps are REQUIRED by
      // `StepDefinitionEntity`'s own constructor invariant to have
      // `prompt === null` — the worker-context endpoint must not throw
      // "does not have an agent prompt" for this kind.
      const workerContext = await unwrapAsync(
        apiClient.api["task-runs"]({
          taskRunId: task.id,
        })["worker-context"].post(
          {
            claimToken,
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(workerContext.task).toMatchObject({
        kind: "code",
        prompt: null,
        entrypointJson: {
          sourceFile: ".scarn/pipeline-builder/review-file-step.ts",
        },
      });
      expect(workerContext.runtime).toMatchObject({
        environment: {
          kind: "inline",
          runtime: { kind: "managed", id: "bun1" },
        },
        repo: { mode: "readWrite", message: null, onPushFailure: "fail" },
      });
    },
  );

  serialTest(
    "returns worker context for a pipeline-linked task, identified by the linked step definition",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId || !stepKey) {
        throw new Error("Expected setup to complete");
      }

      currentTime = new Date("2026-04-28T12:50:00.000Z");
      const workItem = await createTestWorkItem(
        apiClient,
        authHeaders,
        parseUuidV7(project.id),
        "worker-context-linked",
      );
      const definition = await createSingleStepPipelineDefinition(
        apiClient,
        authHeaders,
        parseUuidV7(project.id),
        stepKey,
        { ticketId: "ticket-linked" },
      );
      const execution = await unwrapAsync(
        apiClient.api["pipeline-executions"].post(
          {
            projectId: parseUuidV7(project.id),
            workItemId: parseUuidV7(workItem.id),
            pipelineDefinitionId: definition.id,
          },
          { headers: { ...authHeaders } },
        ),
      );
      const taskRunId = latestTaskIdForNode(execution);

      const claims = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId: parseUuidV7(project.id),
            workerId: "worker-context-linked",
            batchSize: 1,
            leaseDurationSeconds: 30,
            workItemId: workItem.id,
          },
          { headers: { ...authHeaders } },
        ),
      );
      const claimToken = claims[0]?.claimToken;
      if (!claimToken) {
        throw new Error("Expected claim token to be returned");
      }

      const workerContext = await unwrapAsync(
        apiClient.api["task-runs"]({
          taskRunId: taskRunId,
        })["worker-context"].post(
          { claimToken },
          { headers: { ...authHeaders } },
        ),
      );

      expect(workerContext.task).toMatchObject({
        name: "Claimable step",
        kind: "agent",
        prompt: "Return a result payload.",
        resultSchemaJson: { type: "object" },
      });
      expect(workerContext.runtime).toMatchObject({
        environment: {
          kind: "inline",
          runtime: {
            kind: "devcontainer",
            config: ".devcontainer/alt/devcontainer.json",
          },
        },
        repo: {
          mode: "readWrite",
          message: "fix: {{result.summary}}",
          onPushFailure: "warn",
        },
      });
      expect(workerContext.task.key).toContain("claim_step_");
      expect(workerContext.agentPrompt.promptText).toContain(
        `Step key: ${workerContext.task.key}`,
      );
    },
  );

  serialTest(
    "returns the default runtime for a task with no config, titled by name then work item then id",
    async () => {
      if (!project || !authHeaders) {
        throw new Error("Expected setup to complete");
      }
      const projectId = parseUuidV7(project.id);
      const { opencodeMcpJson, environment, repo, ...bare } =
        buildStepDefinitionPayload(
          projectId,
          `claim_default_step_${crypto.randomUUID()}`,
        );
      void [opencodeMcpJson, environment, repo];
      const stepDefinition = await unwrapAsync(
        apiClient.api["step-definitions"].post(bare, {
          headers: { ...authHeaders },
        }),
      );
      const workItem = await createTestWorkItem(
        apiClient,
        authHeaders,
        projectId,
        "worker-context-default",
      );

      currentTime = new Date("2026-04-28T12:55:00.000Z");
      const { task: parent, run: task } = await unwrapStartedTaskAsync(
        apiClient.api.tasks.post(
          {
            projectId,
            workItemId: parseUuidV7(workItem.id),
            stepDefinitionId: stepDefinition.id,
            stepDefinitionVersion: 1,
            inputJson: null,
          },
          { headers: { ...authHeaders } },
        ),
      );
      expect(task.taskExecutionConfigId).toBeNull();

      const claims = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId,
            workerId: "worker-context-default",
            batchSize: 1,
            leaseDurationSeconds: 30,
            workItemId: workItem.id,
          },
          { headers: { ...authHeaders } },
        ),
      );
      const claimToken = claims[0]?.claimToken;
      if (!claimToken) {
        throw new Error("Expected claim token to be returned");
      }
      const fetchWorkerContext = () =>
        unwrapAsync(
          apiClient.api["task-runs"]({ taskRunId: task.id })[
            "worker-context"
          ].post({ claimToken }, { headers: { ...authHeaders } }),
        );

      const named = await fetchWorkerContext();
      expect(named.runtime).toEqual({
        environment: null,
        repo: {
          mode: "readWrite",
          message: null,
          onPushFailure: "fail",
          gitCredentials: "auto",
          baseBranch: null,
          workBranch: { kind: "create" },
        },
        healthChecksJson: null,
        opencodeMcpJson: null,
        extraConnectors: [],
      });
      expect(named.agentPrompt.sessionTitle).toBe(
        `Claimable step (${task.id})`,
      );

      await getDb()
        .update(tasks)
        .set({ name: null })
        .where(eq(tasks.id, parent.id));
      const unnamed = await fetchWorkerContext();
      expect(unnamed.task.name).toBe(workItem.title);
      expect(unnamed.agentPrompt.sessionTitle).toBe(
        `${workItem.title} (${task.id})`,
      );
    },
  );

  serialTest(
    "claims queued pipeline taskRuns by execution work item id",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId || !stepKey) {
        throw new Error("Expected setup to complete");
      }

      const workItem = await unwrapAsync(
        apiClient.api["work-items"].post(
          {
            projectId: project.id,
            platform: "github",
            platformId: `claim-filter-${crypto.randomUUID()}`,
            platformKey: `#claim-filter-${crypto.randomUUID()}`,
            url: "https://github.com/example/repo/issues/claim-filter",
            title: "Claim filter work item",
            description: "Work item for claim filter test",
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            fields: {},
          },
          { headers: { ...authHeaders } },
        ),
      );
      const definition = await createSingleStepPipelineDefinition(
        apiClient,
        authHeaders,
        parseUuidV7(project.id),
        stepKey,
      );

      const execution = await unwrapAsync(
        apiClient.api["pipeline-executions"].post(
          {
            projectId: parseUuidV7(project.id),
            workItemId: parseUuidV7(workItem.id),
            pipelineDefinitionId: definition.id,
          },
          { headers: { ...authHeaders } },
        ),
      );
      const queuedTaskId = latestTaskIdForNode(execution);

      const claims = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId: parseUuidV7(project.id),
            workerId: "work-item-filter-worker",
            batchSize: 1,
            leaseDurationSeconds: 30,
            workItemId: workItem.id,
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(claims).toHaveLength(1);
      expect(claims[0]?.task.id).toBe(queuedTaskId);
      expect(claims[0]?.task.status).toBe("running");

      const advancedExecution = await unwrapAsync(
        apiClient.api["pipeline-executions"]({
          pipelineExecutionId: execution.id,
        }).get({ headers: { ...authHeaders } }),
      );
      expect(advancedExecution.status).toBe("running");
      expect(
        advancedExecution.visits
          .flatMap((visit) => visit.tasks)
          .find((task) => task.taskId === queuedTaskId)?.status,
      ).toBe("running");
    },
  );

  serialTest(
    "marks the step abandoned when lease expires and does not allow reclaim",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId || !stepKey) {
        throw new Error("Expected setup to complete");
      }

      currentTime = new Date("2026-04-28T13:00:00.000Z");
      const { run: task } = await unwrapStartedTaskAsync(
        apiClient.api.tasks.post(
          {
            projectId: parseUuidV7(project.id),
            workItemId: await seedWorkItem(parseUuidV7(project.id)),
            stepDefinitionId,
            stepDefinitionVersion: 1,
            inputJson: { ticketId: "ticket-2" },
            executionTimeoutSeconds: 300,
          },
          { headers: { ...authHeaders } },
        ),
      );

      const firstClaim = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId: parseUuidV7(project.id),
            workerId: "worker-a",
            batchSize: 1,
            leaseDurationSeconds: 30,
          },
          { headers: { ...authHeaders } },
        ),
      );
      const firstClaimToken = firstClaim[0]?.claimToken;
      if (!firstClaimToken) {
        throw new Error("Expected first claim token");
      }

      currentTime = new Date("2026-04-28T13:00:31.000Z");
      const secondClaim = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId: parseUuidV7(project.id),
            workerId: "worker-b",
            batchSize: 1,
            leaseDurationSeconds: 30,
          },
          { headers: { ...authHeaders } },
        ),
      );
      expect(secondClaim).toHaveLength(0);

      const abandonedExecution = await unwrapAsync(
        apiClient.api["task-runs"]({
          taskRunId: task.id,
        }).get({
          headers: { ...authHeaders },
        }),
      );
      expect(abandonedExecution.status).toBe("abandoned");
      // The second claim pass saw the lapsed lease and failed the Task as
      // abandoned, which clears the stale worker's claim.
      expect(abandonedExecution.claimedBy).toBeNull();
      expect(abandonedExecution.errorJson).toMatchObject({
        code: "TASK_ABANDONED",
      });

      const staleCompletion = await apiClient.api["task-runs"]({
        taskRunId: task.id,
      }).completions.post(
        {
          claimToken: firstClaimToken,
          status: "succeeded",
          resultJson: { status: "completed" },
          errorJson: null,
        },
        { headers: { ...authHeaders } },
      );

      expect(staleCompletion.data).toBeNull();
      expect(staleCompletion.error?.status).toBe(409);
      expect(staleCompletion.error?.value).toMatchObject({
        code: "TASK_OWNERSHIP_CONFLICT",
      });
    },
  );

  serialTest(
    "refuses heartbeats with a wrong token, a lapsed lease, or without executions:write",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId) {
        throw new Error("Expected setup to complete");
      }
      const projectId = parseUuidV7(project.id);

      currentTime = new Date("2026-04-28T13:30:00.000Z");
      const { run: task } = await unwrapStartedTaskAsync(
        apiClient.api.tasks.post(
          {
            projectId,
            workItemId: await seedWorkItem(projectId),
            stepDefinitionId,
            stepDefinitionVersion: 1,
            inputJson: { ticketId: "ticket-heartbeat-refusals" },
            executionTimeoutSeconds: 300,
          },
          { headers: { ...authHeaders } },
        ),
      );
      const claims = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId,
            workerId: "worker-heartbeat-refusals",
            batchSize: 1,
            leaseDurationSeconds: 30,
          },
          { headers: { ...authHeaders } },
        ),
      );
      const claimToken = claims[0]?.claimToken;
      if (!claimToken || claims[0]?.task.id !== task.id) {
        throw new Error("Expected to claim the new task");
      }
      const heartbeat = (token: string, headers: { authorization: string }) =>
        apiClient.api["task-runs"]({ taskRunId: task.id }).heartbeat.put(
          { claimToken: token, leaseDurationSeconds: 30 },
          { headers: { ...headers } },
        );

      const reader = await createTestUserAndSession({
        email: `task-claims-reader-${crypto.randomUUID()}@example.com`,
      });
      await unwrapAsync(
        apiClient.api
          .projects({ projectId: project.id })
          .members({ userId: reader.userId })
          .role.put({ role: "read" }, { headers: { ...authHeaders } }),
      );
      const forbidden = await heartbeat(claimToken, reader.authHeaders);
      expect(forbidden.error?.status).toBe(403);
      expect(forbidden.error?.value).toMatchObject({
        code: "PROJECT_FORBIDDEN",
      });

      const wrongToken = await heartbeat("not-the-claim-token", authHeaders);
      expect(wrongToken.error?.status).toBe(409);
      expect(wrongToken.error?.value).toMatchObject({
        code: "TASK_OWNERSHIP_CONFLICT",
      });

      currentTime = new Date("2026-04-28T13:30:31.000Z");
      const lapsed = await heartbeat(claimToken, authHeaders);
      expect(lapsed.error?.status).toBe(409);
      expect(lapsed.error?.value).toMatchObject({
        code: "TASK_OWNERSHIP_CONFLICT",
      });

      const [row] = await getDb()
        .select({ lastHeartbeatAt: taskRuns.lastHeartbeatAt })
        .from(taskRuns)
        .where(eq(taskRuns.id, task.id));
      expect(row?.lastHeartbeatAt?.toISOString()).toBe(
        "2026-04-28T13:30:00.000Z",
      );
    },
  );

  serialTest(
    "times out the step when the worker heartbeats after the deadline",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId || !stepKey) {
        throw new Error("Expected setup to complete");
      }

      currentTime = new Date("2026-04-28T14:00:00.000Z");
      const { run: task } = await unwrapStartedTaskAsync(
        apiClient.api.tasks.post(
          {
            projectId: parseUuidV7(project.id),
            workItemId: await seedWorkItem(parseUuidV7(project.id)),
            stepDefinitionId,
            stepDefinitionVersion: 1,
            inputJson: { ticketId: "ticket-3" },
            executionTimeoutSeconds: 15,
          },
          { headers: { ...authHeaders } },
        ),
      );

      const claims = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId: parseUuidV7(project.id),
            workerId: "worker-timeout",
            batchSize: 1,
            leaseDurationSeconds: 30,
          },
          { headers: { ...authHeaders } },
        ),
      );
      const claimToken = claims[0]?.claimToken;
      if (!claimToken) {
        throw new Error("Expected timeout claim token");
      }

      currentTime = new Date("2026-04-28T14:00:16.000Z");
      const timedOutExecution = await unwrapAsync(
        apiClient.api["task-runs"]({
          taskRunId: task.id,
        }).heartbeat.put(
          {
            claimToken,
            leaseDurationSeconds: 30,
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(timedOutExecution.id).toBe(task.id);
      expect(timedOutExecution.status).toBe("timeout");
      expect(timedOutExecution.claimedBy).toBeNull();
      expect(toIsoString(timedOutExecution.completedAt)).toBe(
        "2026-04-28T14:00:16.000Z",
      );

      const persistedExecution = await unwrapAsync(
        apiClient.api["task-runs"]({
          taskRunId: task.id,
        }).get({
          headers: { ...authHeaders },
        }),
      );

      expect(persistedExecution).toMatchObject({
        status: "timeout",
        resultJson: null,
        errorJson: { code: "TASK_TIMED_OUT" },
      });
    },
  );

  serialTest(
    "claims a fresh queued execution even when older stale running rows exist",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId || !stepKey) {
        throw new Error("Expected setup to complete");
      }

      currentTime = new Date("2026-04-28T15:00:00.000Z");

      for (const suffix of ["a", "b", "c"] as const) {
        await unwrapAsync(
          apiClient.api.tasks.post(
            {
              projectId: parseUuidV7(project.id),
              workItemId: await seedWorkItem(parseUuidV7(project.id)),
              stepDefinitionId,
              stepDefinitionVersion: 1,
              inputJson: { ticketId: `stale-${suffix}` },
              executionTimeoutSeconds: 1,
            },
            { headers: { ...authHeaders } },
          ),
        );
      }

      const staleClaims = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId: parseUuidV7(project.id),
            workerId: "stale-rows-worker",
            batchSize: 3,
            leaseDurationSeconds: 30,
          },
          { headers: { ...authHeaders } },
        ),
      );
      expect(staleClaims).toHaveLength(3);

      currentTime = new Date("2026-04-28T15:02:00.000Z");
      const { run: freshExecution } = await unwrapStartedTaskAsync(
        apiClient.api.tasks.post(
          {
            projectId: parseUuidV7(project.id),
            workItemId: await seedWorkItem(parseUuidV7(project.id)),
            stepDefinitionId,
            stepDefinitionVersion: 1,
            inputJson: { ticketId: "fresh-queued" },
            executionTimeoutSeconds: 300,
          },
          { headers: { ...authHeaders } },
        ),
      );

      const claimResult = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId: parseUuidV7(project.id),
            workerId: "fresh-rows-worker",
            batchSize: 1,
            leaseDurationSeconds: 30,
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(claimResult).toHaveLength(1);
      expect(claimResult[0]?.task.id).toBe(freshExecution.id);
      expect(claimResult[0]?.task.status).toBe("running");
    },
  );

  // Phase 3 (docs/plans/claim-step-executions-batching.md): the claim path
  // now claims the whole batch in one atomic statement
  // (`TaskRunRepo.claimBatch`) instead of a per-candidate transaction
  // loop. These tests target that statement's own guarantees directly.
  serialTest(
    "claiming with batchSize greater than the number of available queued rows returns exactly the available rows, each running with a distinct claim token",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId || !stepKey) {
        throw new Error("Expected setup to complete");
      }

      currentTime = new Date("2026-04-28T16:00:00.000Z");
      const seededProjectId = parseUuidV7(project.id);
      const seededStepDefinitionId = stepDefinitionId;
      const seeded = await Promise.all(
        ["one", "two"].map(async (suffix) =>
          unwrapStartedTaskAsync(
            apiClient.api.tasks.post(
              {
                projectId: seededProjectId,
                workItemId: await seedWorkItem(seededProjectId),
                stepDefinitionId: seededStepDefinitionId,
                stepDefinitionVersion: 1,
                inputJson: { ticketId: `batch-overfetch-${suffix}` },
                executionTimeoutSeconds: 120,
              },
              { headers: { ...authHeaders } },
            ),
          ),
        ),
      );

      const claims = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId: parseUuidV7(project.id),
            workerId: "overfetch-worker",
            batchSize: 10,
            leaseDurationSeconds: 30,
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(claims).toHaveLength(seeded.length);
      const claimedIds = claims.map((claim) => claim.task.id).sort();
      expect(claimedIds).toEqual([...seeded.map((item) => item.run.id)].sort());
      for (const claim of claims) {
        expect(claim.task.status).toBe("running");
      }
      expect(new Set(claims.map((claim) => claim.claimToken)).size).toBe(
        claims.length,
      );
    },
  );

  serialTest(
    "workItemId-scoped claiming with batchSize > 1 only returns rows linked to that work item, even when other queued rows exist in the project",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId || !stepKey) {
        throw new Error("Expected setup to complete");
      }

      // A standalone queued task in the same project on another
      // work item — must never be returned by a workItemId-scoped claim,
      // batched or not.
      currentTime = new Date("2026-04-28T16:10:00.000Z");
      await unwrapAsync(
        apiClient.api.tasks.post(
          {
            projectId: parseUuidV7(project.id),
            workItemId: await seedWorkItem(parseUuidV7(project.id)),
            stepDefinitionId,
            stepDefinitionVersion: 1,
            inputJson: { ticketId: "unlinked-standalone" },
            executionTimeoutSeconds: 120,
          },
          { headers: { ...authHeaders } },
        ),
      );

      const workItem = await unwrapAsync(
        apiClient.api["work-items"].post(
          {
            projectId: project.id,
            platform: "github",
            platformId: `claim-batch-filter-${crypto.randomUUID()}`,
            platformKey: `#claim-batch-filter-${crypto.randomUUID()}`,
            url: "https://github.com/example/repo/issues/claim-batch-filter",
            title: "Claim batch filter work item",
            description: "Work item for batched claim filter test",
            sourceCreatedAt: null,
            sourceUpdatedAt: null,
            fields: {},
          },
          { headers: { ...authHeaders } },
        ),
      );
      const definition = await createSingleStepPipelineDefinition(
        apiClient,
        authHeaders,
        parseUuidV7(project.id),
        stepKey,
      );
      const execution = await unwrapAsync(
        apiClient.api["pipeline-executions"].post(
          {
            projectId: parseUuidV7(project.id),
            workItemId: parseUuidV7(workItem.id),
            pipelineDefinitionId: definition.id,
          },
          { headers: { ...authHeaders } },
        ),
      );
      const queuedTaskId = latestTaskIdForNode(execution);

      const claims = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId: parseUuidV7(project.id),
            workerId: "batch-work-item-filter-worker",
            batchSize: 5,
            leaseDurationSeconds: 30,
            workItemId: workItem.id,
          },
          { headers: { ...authHeaders } },
        ),
      );

      expect(claims).toHaveLength(1);
      expect(claims[0]?.task.id).toBe(queuedTaskId);
      expect(claims[0]?.task.status).toBe("running");

      // The standalone row from above was deliberately never
      // claimed (out of the workItemId scope) — sweep it here so it does
      // not linger as an unclaimed `queued` row for later tests in this
      // file to unexpectedly pick up.
      await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId: parseUuidV7(project.id),
            workerId: "batch-work-item-filter-sweep-worker",
            batchSize: 10,
            leaseDurationSeconds: 30,
          },
          { headers: { ...authHeaders } },
        ),
      );
    },
  );

  serialTest(
    "two concurrent claim calls for the same project never return overlapping task ids (SKIP LOCKED)",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId || !stepKey) {
        throw new Error("Expected setup to complete");
      }

      currentTime = new Date("2026-04-28T16:20:00.000Z");
      const seededProjectId = parseUuidV7(project.id);
      const seededStepDefinitionId = stepDefinitionId;
      const seeded = await Promise.all(
        ["a", "b", "c", "d"].map(async (suffix) =>
          unwrapAsync(
            apiClient.api.tasks.post(
              {
                projectId: seededProjectId,
                workItemId: await seedWorkItem(seededProjectId),
                stepDefinitionId: seededStepDefinitionId,
                stepDefinitionVersion: 1,
                inputJson: { ticketId: `skip-locked-${suffix}` },
                executionTimeoutSeconds: 120,
              },
              { headers: { ...authHeaders } },
            ),
          ),
        ),
      );

      const [claimsA, claimsB] = await Promise.all([
        unwrapAsync(
          apiClient.api["task-runs"].claims.post(
            {
              projectId: parseUuidV7(project.id),
              workerId: "skip-locked-worker-a",
              batchSize: 2,
              leaseDurationSeconds: 30,
            },
            { headers: { ...authHeaders } },
          ),
        ),
        unwrapAsync(
          apiClient.api["task-runs"].claims.post(
            {
              projectId: parseUuidV7(project.id),
              workerId: "skip-locked-worker-b",
              batchSize: 2,
              leaseDurationSeconds: 30,
            },
            { headers: { ...authHeaders } },
          ),
        ),
      ]);

      const idsA = claimsA.map((claim) => claim.task.id);
      const idsB = claimsB.map((claim) => claim.task.id);
      // The `SKIP LOCKED` guarantee under test: two concurrent `claimBatch`
      // calls never return overlapping ids, regardless of whatever else is
      // sitting in the project's queue at the time.
      const overlap = idsA.filter((id) => idsB.includes(id));
      expect(overlap).toEqual([]);

      // Neither call over-claimed beyond its own requested batchSize.
      expect(idsA.length).toBeLessThanOrEqual(2);
      expect(idsB.length).toBeLessThanOrEqual(2);
      // The 4 freshly-seeded rows were the only queued rows in the
      // project, so together the two racing calls (batchSize 2 each)
      // claimed the full 4.
      expect(seeded).toHaveLength(4);
      expect(idsA.length + idsB.length).toBe(4);
    },
  );

  // Phase 4 (docs/plans/claim-step-executions-batching.md): claimed,
  // pipeline-linked items are now grouped by `pipelineRunId` and each
  // group's `applyPipelineNodeRunRunningTransition` calls run concurrently
  // across groups (sequentially within a group). These tests target that
  // behavior directly against a real, persisted `PipelineRun` aggregate,
  // not a mock.
  serialTest(
    "two claimed steps from different pipeline runs both end up running",
    async () => {
      if (!project || !authHeaders || !stepDefinitionId || !stepKey) {
        throw new Error("Expected setup to complete");
      }
      const currentProject = project;
      const currentAuthHeaders = authHeaders;

      currentTime = new Date("2026-04-28T16:30:00.000Z");
      const definition = await createSingleStepPipelineDefinition(
        apiClient,
        currentAuthHeaders,
        parseUuidV7(currentProject.id),
        stepKey,
      );

      const createLinkedExecution = async (suffix: string) => {
        const workItem = await createTestWorkItem(
          apiClient,
          currentAuthHeaders,
          parseUuidV7(currentProject.id),
          `phase4-diff-run-${suffix}`,
        );
        return await unwrapAsync(
          apiClient.api["pipeline-executions"].post(
            {
              projectId: parseUuidV7(currentProject.id),
              workItemId: parseUuidV7(workItem.id),
              pipelineDefinitionId: definition.id,
            },
            { headers: { ...currentAuthHeaders } },
          ),
        );
      };

      const executionOne = await createLinkedExecution("one");
      const executionTwo = await createLinkedExecution("two");
      const taskOne = latestTaskIdForNode(executionOne);
      const taskTwo = latestTaskIdForNode(executionTwo);

      const claims = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId: parseUuidV7(project.id),
            workerId: "phase4-diff-run-worker",
            batchSize: 5,
            leaseDurationSeconds: 30,
          },
          { headers: { ...authHeaders } },
        ),
      );
      const claimedIds = claims.map((claim) => claim.task.id);
      expect(claimedIds).toContain(taskOne);
      expect(claimedIds).toContain(taskTwo);

      const advancedOne = await unwrapAsync(
        apiClient.api["pipeline-executions"]({
          pipelineExecutionId: executionOne.id,
        }).get({ headers: { ...authHeaders } }),
      );
      const advancedTwo = await unwrapAsync(
        apiClient.api["pipeline-executions"]({
          pipelineExecutionId: executionTwo.id,
        }).get({ headers: { ...authHeaders } }),
      );

      expect(advancedOne.status).toBe("running");
      expect(advancedTwo.status).toBe("running");
      const taskStatus = (
        execution: typeof advancedOne,
        taskRunId: UuidV7,
      ): string | undefined =>
        execution.visits
          .flatMap((visit) => visit.tasks)
          .find((task) => task.taskId === taskRunId)?.status;
      expect(taskStatus(advancedOne, taskOne)).toBe("running");
      expect(taskStatus(advancedTwo, taskTwo)).toBe("running");
    },
  );

  serialTest(
    "two lanes of the same pipeline run both end up running when claimed together",
    async () => {
      if (!project || !authHeaders || !stepKey) {
        throw new Error("Expected setup to complete");
      }
      const currentProject = project;
      const currentAuthHeaders = authHeaders;

      currentTime = new Date("2026-04-28T16:35:00.000Z");
      const definition = await createParallelBranchPipelineDefinition(
        apiClient,
        currentAuthHeaders,
        parseUuidV7(currentProject.id),
        stepKey,
      );
      const workItem = await createTestWorkItem(
        apiClient,
        currentAuthHeaders,
        parseUuidV7(currentProject.id),
        "same-run-lanes",
      );
      const execution = await unwrapAsync(
        apiClient.api["pipeline-executions"].post(
          {
            projectId: parseUuidV7(currentProject.id),
            workItemId: parseUuidV7(workItem.id),
            pipelineDefinitionId: definition.id,
          },
          { headers: { ...currentAuthHeaders } },
        ),
      );
      const entryTaskId = latestTaskIdForNode(execution, "entry");

      const entryClaims = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId: parseUuidV7(project.id),
            workerId: "same-run-entry-worker",
            batchSize: 1,
            leaseDurationSeconds: 30,
            workItemId: workItem.id,
          },
          { headers: { ...authHeaders } },
        ),
      );
      const entryClaimToken = entryClaims[0]?.claimToken;
      if (!entryClaimToken) {
        throw new Error("Expected entry claim token");
      }

      const completedEntry = await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: entryTaskId }).completions.post(
          {
            claimToken: entryClaimToken,
            status: "succeeded",
            resultJson: { branches: ["a", "b"] },
            errorJson: null,
          },
          { headers: { ...authHeaders } },
        ),
      );
      expect(completedEntry.id).toBe(entryTaskId);

      const beforeClaim = await unwrapAsync(
        apiClient.api["pipeline-executions"]({
          pipelineExecutionId: execution.id,
        }).get({ headers: { ...authHeaders } }),
      );
      const laneVisitsBeforeClaim = beforeClaim.visits.filter(
        (visit) => visit.nodeId === "branch",
      );
      expect(laneVisitsBeforeClaim).toHaveLength(2);
      expect(beforeClaim.lanes).toHaveLength(2);
      expect(
        laneVisitsBeforeClaim.map((visit) => visit.tasks.at(-1)?.status),
      ).toEqual(["queued", "queued"]);

      const branchClaims = await unwrapAsync(
        apiClient.api["task-runs"].claims.post(
          {
            projectId: parseUuidV7(project.id),
            workerId: "same-run-lane-worker",
            batchSize: 2,
            leaseDurationSeconds: 30,
            workItemId: workItem.id,
          },
          { headers: { ...authHeaders } },
        ),
      );
      expect(branchClaims).toHaveLength(2);
      const claimedBranchIds = branchClaims
        .map((claim) => claim.task.id)
        .sort();
      const expectedBranchIds = laneVisitsBeforeClaim
        .flatMap((visit) => visit.tasks.map((task) => task.taskId))
        .sort();
      expect(claimedBranchIds).toEqual(expectedBranchIds);

      const advancedExecution = await unwrapAsync(
        apiClient.api["pipeline-executions"]({
          pipelineExecutionId: execution.id,
        }).get({ headers: { ...authHeaders } }),
      );
      expect(advancedExecution.status).toBe("running");
      const laneTaskStatuses = advancedExecution.visits
        .filter((visit) => visit.nodeId === "branch")
        .map((visit) => visit.tasks.at(-1)?.status);
      expect(laneTaskStatuses).toEqual(["running", "running"]);
    },
  );
});
