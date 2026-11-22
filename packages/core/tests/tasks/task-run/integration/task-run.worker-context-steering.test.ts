import { beforeAll, describe, expect } from "bun:test";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import { fixedTimeProvider, serialTest, unwrapAsync } from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import {
  buildStepDefinitionPayload,
  createTestWorkItem,
} from "./task-run-test-support";
import {
  chainedPipelineDocument,
  createPipelineFromDocument,
} from "tests/pipeline-definitions/pipeline-test-support";

type Claim = { taskRunId: UuidV7; claimToken: string };

describe("task worker context: step steering", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-05-01T09:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);
  let projectId: UuidV7 | undefined;
  let stepDefinitionId: UuidV7 | undefined;
  let stepDefinitionKey: string | undefined;
  let authHeaders: { authorization: string } | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `worker-context-steering-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Worker Context Steering Project",
          description: "Project for worker-context steering tests",
          gitUrl: "https://github.com/example/test-project.git",
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    projectId = parseUuidV7(project.id);
    const stepDefinition = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        buildStepDefinitionPayload(
          projectId,
          `steering_step_${crypto.randomUUID()}`,
        ),
        { headers: { ...owner.authHeaders } },
      ),
    );
    stepDefinitionId = stepDefinition.id;
    stepDefinitionKey = stepDefinition.key;
  });

  const requireSetup = () => {
    if (!projectId || !stepDefinitionId || !stepDefinitionKey || !authHeaders) {
      throw new Error("Expected setup to complete");
    }
    return {
      projectId,
      stepDefinitionId,
      stepDefinitionKey,
      headers: { ...authHeaders },
    };
  };

  const startInvestigateFixRun = async () => {
    const { projectId, stepDefinitionKey, headers } = requireSetup();
    const definition = await createPipelineFromDocument(
      apiClient,
      headers,
      projectId,
      chainedPipelineDocument(`steering-pipeline-${crypto.randomUUID()}`, [
        { nodeId: "investigate", stepKey: stepDefinitionKey },
        { nodeId: "fix", stepKey: stepDefinitionKey },
      ]),
      "Steering pipeline",
    );
    const workItem = await createTestWorkItem(
      apiClient,
      headers,
      projectId,
      "steering",
    );
    const execution = await unwrapAsync(
      apiClient.api["pipeline-executions"].post(
        {
          projectId,
          workItemId: parseUuidV7(workItem.id),
          pipelineDefinitionId: definition.id,
        },
        { headers },
      ),
    );
    return { executionId: execution.id, workItemId: workItem.id };
  };

  const claimOne = async (workItemId: string): Promise<Claim> => {
    const { projectId, headers } = requireSetup();
    const [claim] = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workerId: "steering-worker",
          batchSize: 1,
          leaseDurationSeconds: 30,
          workItemId,
        },
        { headers },
      ),
    );
    if (!claim) {
      throw new Error("Expected a claim");
    }
    return { taskRunId: claim.task.id, claimToken: claim.claimToken };
  };

  const workerContextOf = async (claim: Claim) =>
    await unwrapAsync(
      apiClient.api["task-runs"]({ taskRunId: claim.taskRunId })[
        "worker-context"
      ].post(
        { claimToken: claim.claimToken },
        { headers: requireSetup().headers },
      ),
    );

  const complete = async (
    claim: Claim,
    status: "succeeded" | "failed",
    workBranch: string | null,
  ) =>
    await unwrapAsync(
      apiClient.api["task-runs"]({
        taskRunId: claim.taskRunId,
      }).completions.post(
        {
          claimToken: claim.claimToken,
          status,
          resultJson: { summary: `${status} on ${workBranch ?? "none"}` },
          errorJson: status === "failed" ? { message: "boom" } : null,
          workBranch,
        },
        { headers: requireSetup().headers },
      ),
    );

  const sendMessage = async (
    executionId: string,
    nodeId: string,
    body: string,
    quoteText?: string,
  ) => {
    const { headers } = requireSetup();
    const execution = await unwrapAsync(
      apiClient.api["pipeline-executions"]({
        pipelineExecutionId: executionId,
      }).get({ headers }),
    );
    const visit = execution.visits
      .filter((item) => item.nodeId === nodeId && item.status !== "superseded")
      .at(-1);
    if (!visit) {
      throw new Error(`Expected a visit to ${nodeId}`);
    }
    return await unwrapAsync(
      apiClient.api["pipeline-executions"]({
        pipelineExecutionId: executionId,
      })
        .visits({ visitId: visit.id })
        .messages.post(
          { body, ...(quoteText ? { quoteText } : {}) },
          { headers },
        ),
    );
  };

  const runBothSteps = async (
    fixStatus: "succeeded" | "failed" = "succeeded",
  ) => {
    const run = await startInvestigateFixRun();
    const investigate = await claimOne(run.workItemId);
    await complete(investigate, "succeeded", "scarn/investigate-1");
    const fix = await claimOne(run.workItemId);
    await complete(
      fix,
      fixStatus,
      fixStatus === "succeeded" ? "scarn/fix-1" : null,
    );
    return { ...run, investigate, fix };
  };

  const normalizedPrompt = (
    promptText: string,
    taskRunId: UuidV7,
    workItemId: string,
  ) => {
    const { projectId, stepDefinitionKey } = requireSetup();
    return promptText
      .replaceAll(projectId, "<projectId>")
      .replaceAll(taskRunId, "<taskRunId>")
      .replaceAll(workItemId, "<workItemId>")
      .replaceAll(stepDefinitionKey, "<stepKey>")
      .replace(/"workItemId": "[^"]+"/g, '"workItemId": "<workItemId>"')
      .replace(/"platformKey": "[^"]+"/g, '"platformKey": "<platformKey>"');
  };

  serialTest(
    "a steered run continues from the previous run's branch and findings",
    async () => {
      const run = await runBothSteps();
      await sendMessage(
        run.executionId,
        "fix",
        "That timeout is a symptom. Look at why the cart lock is never released.",
        "Reproduces 9/10 under load.",
      );

      const steered = await claimOne(run.workItemId);
      const context = await workerContextOf(steered);
      expect(context.baseWorkBranch).toBe("scarn/fix-1");
      expect(context.previousRun).toEqual({
        taskRunId: run.fix.taskRunId,
        status: "succeeded",
        transcriptRelativePath: ".scarn/previous-run/transcript.txt",
        findingsRelativePath: ".scarn/previous-run/findings.json",
        findingsJson: { summary: "succeeded on scarn/fix-1" },
      });
      expect(
        normalizedPrompt(
          context.agentPrompt.promptText,
          steered.taskRunId,
          run.workItemId,
        ),
      ).toMatchSnapshot();
      await complete(steered, "succeeded", "scarn/fix-2");
    },
  );

  serialTest(
    "a steered run after a failed run continues from the nearest succeeded run's branch",
    async () => {
      const run = await runBothSteps();
      await sendMessage(run.executionId, "fix", "Try the lock first.");
      const failed = await claimOne(run.workItemId);
      await complete(failed, "failed", null);

      await sendMessage(run.executionId, "fix", "Now try the timeout.");
      const steered = await claimOne(run.workItemId);
      const context = await workerContextOf(steered);
      expect(context.baseWorkBranch).toBe("scarn/fix-1");
      expect(context.previousRun).toMatchObject({
        taskRunId: failed.taskRunId,
        status: "failed",
        findingsJson: { summary: "failed on none" },
      });
      expect(context.agentPrompt.promptText).toContain(
        "Your work branch starts from scarn/fix-1, the branch of the last run of this step that succeeded.",
      );
      await complete(steered, "succeeded", "scarn/fix-3");
    },
  );

  serialTest(
    "a steered run with no succeeded run in its chain starts from the upstream branch",
    async () => {
      const run = await runBothSteps("failed");
      await sendMessage(run.executionId, "fix", "The fixture path is wrong.");

      const steered = await claimOne(run.workItemId);
      const context = await workerContextOf(steered);
      expect(context.baseWorkBranch).toBe("scarn/investigate-1");
      expect(context.previousRun?.status).toBe("failed");
      expect(context.agentPrompt.promptText).toContain(
        "No earlier run of this step left a work branch to build on, so your work branch starts from the upstream branch, scarn/investigate-1.",
      );
      await complete(steered, "succeeded", "scarn/fix-2");
    },
  );

  serialTest(
    "a downstream visit after an upstream rerun starts fresh from the new upstream branch",
    async () => {
      const run = await runBothSteps();
      await sendMessage(run.executionId, "fix", "Release the cart lock.");
      const steeredFix = await claimOne(run.workItemId);
      await complete(steeredFix, "succeeded", "scarn/fix-2");

      await sendMessage(
        run.executionId,
        "investigate",
        "Check the checkout service too.",
      );
      const steeredInvestigate = await claimOne(run.workItemId);
      const investigateContext = await workerContextOf(steeredInvestigate);
      expect(investigateContext.agentPrompt.promptText).not.toContain(
        "Release the cart lock.",
      );
      await complete(steeredInvestigate, "succeeded", "scarn/investigate-2");

      const rerunFix = await claimOne(run.workItemId);
      const context = await workerContextOf(rerunFix);
      expect(context.baseWorkBranch).toBe("scarn/investigate-2");
      expect(context.previousRun).toBeNull();
      expect(context.agentPrompt.promptText).not.toContain(
        "Release the cart lock.",
      );
      await complete(rerunFix, "succeeded", "scarn/fix-3");
    },
  );

  serialTest("a run of a step nobody messaged has no steering", async () => {
    const run = await startInvestigateFixRun();
    const investigate = await claimOne(run.workItemId);
    const context = await workerContextOf(investigate);
    expect(context.previousRun).toBeNull();
    expect(context.agentPrompt.promptText).not.toContain(
      "from the user to this step",
    );
    await complete(investigate, "succeeded", null);
  });
});
