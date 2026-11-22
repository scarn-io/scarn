import { beforeAll, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { taskRuns, tasks } from "@/lib/db/schema";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import { createApp } from "@scarn/api/app";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import type { AnyJsonObject } from "@scarn/core/common/contracts/json";
import { createScarnTreaty } from "tests/treaty";
import { createAppContext } from "@/lib/di";
import {
  fixedTimeProvider,
  serialTest,
  unwrapAsync,
  unwrapStartedTaskAsync,
} from "tests/utils";
import { createTestUserAndSession } from "tests/projects/project/integration/auth-test-utils";
import {
  chainedPipelineDocument,
  createPipelineFromDocument,
} from "tests/pipeline-definitions/pipeline-test-support";
import {
  buildStepDefinitionPayload,
  createTestWorkItem,
} from "./task-run-test-support";
import { seedWorkItem } from "tests/lib/db/seed-task-prerequisites";

describe("task worker context: base work branch", () => {
  const app = createApp(
    createAppContext({
      timeProvider: fixedTimeProvider(new Date("2026-05-01T09:00:00.000Z")),
    }),
  );
  const apiClient = createScarnTreaty(app);
  let projectId: UuidV7 | undefined;
  let stepDefinitionId: UuidV7 | undefined;
  let stepKey: string | undefined;
  let basedStepKey: string | undefined;
  let authHeaders: { authorization: string } | undefined;

  beforeAll(async () => {
    const owner = await createTestUserAndSession({
      email: `worker-context-base-branch-${crypto.randomUUID()}@example.com`,
    });
    authHeaders = owner.authHeaders;
    const project = await unwrapAsync(
      apiClient.api.projects.post(
        {
          name: "Worker Context Base Branch Project",
          description: "Project for worker-context base branch tests",
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
          `base_branch_step_${crypto.randomUUID()}`,
        ),
        { headers: { ...owner.authHeaders } },
      ),
    );
    stepDefinitionId = stepDefinition.id;
    stepKey = stepDefinition.key;
    const withBaseBranch = await unwrapAsync(
      apiClient.api["step-definitions"].post(
        {
          ...buildStepDefinitionPayload(
            projectId,
            `with_base_branch_step_${crypto.randomUUID()}`,
          ),
          repo: { mode: "readWrite", baseBranch: "ephemeral-main" },
        },
        { headers: { ...owner.authHeaders } },
      ),
    );
    basedStepKey = withBaseBranch.key;
  });

  const requireSetup = () => {
    if (!projectId || !stepDefinitionId || !stepKey || !authHeaders) {
      throw new Error("Expected setup to complete");
    }
    return {
      projectId,
      stepDefinitionId,
      stepKey,
      headers: { ...authHeaders },
    };
  };

  const chain = (...nodeIds: string[]) => {
    const { stepKey } = requireSetup();
    return chainedPipelineDocument(
      `base-branch-pipeline-${crypto.randomUUID()}`,
      nodeIds.map((nodeId) => ({ nodeId, stepKey })),
    );
  };

  const startPipelineRun = async (document: PipelineDocument) => {
    const { projectId, headers } = requireSetup();
    const definition = await createPipelineFromDocument(
      apiClient,
      headers,
      projectId,
      document,
      "Base branch pipeline",
    );
    const workItem = await createTestWorkItem(
      apiClient,
      headers,
      projectId,
      "base-branch",
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

  const claimNext = async (workItemId: string, batchSize = 1) => {
    const { projectId, headers } = requireSetup();
    const claims = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workerId: "base-branch-worker",
          batchSize,
          leaseDurationSeconds: 30,
          workItemId,
        },
        { headers },
      ),
    );
    if (claims.length !== batchSize) {
      throw new Error(
        `Expected ${String(batchSize)} claim(s), received ${String(claims.length)}`,
      );
    }
    return claims.map((claim) => ({
      taskRunId: claim.task.id,
      claimToken: claim.claimToken,
    }));
  };

  const claimOne = async (workItemId: string) => {
    const [claim] = await claimNext(workItemId);
    if (!claim) {
      throw new Error("Expected a claim");
    }
    return claim;
  };

  const baseWorkBranchOf = async (claim: {
    taskRunId: UuidV7;
    claimToken: string;
  }) => {
    const workerContext = await unwrapAsync(
      apiClient.api["task-runs"]({
        taskRunId: claim.taskRunId,
      })["worker-context"].post(
        { claimToken: claim.claimToken },
        { headers: requireSetup().headers },
      ),
    );
    return workerContext.baseWorkBranch;
  };

  const complete = async (
    claim: { taskRunId: UuidV7; claimToken: string },
    workBranch: string | null,
    resultJson: AnyJsonObject = { status: "completed" },
  ) =>
    await unwrapAsync(
      apiClient.api["task-runs"]({
        taskRunId: claim.taskRunId,
      }).completions.post(
        {
          claimToken: claim.claimToken,
          status: "succeeded",
          resultJson,
          errorJson: null,
          workBranch,
        },
        { headers: requireSetup().headers },
      ),
    );

  serialTest("the first step has no base work branch", async () => {
    const { workItemId } = await startPipelineRun(chain("first", "second"));

    const first = await claimOne(workItemId);
    expect(await baseWorkBranchOf(first)).toBeNull();
    await complete(first, null);

    const second = await claimOne(workItemId);
    await complete(second, null);
  });

  serialTest(
    "the second step branches off the first step's work branch",
    async () => {
      const { workItemId } = await startPipelineRun(chain("first", "second"));

      const first = await claimOne(workItemId);
      await complete(first, "scarn/first-work");

      const second = await claimOne(workItemId);
      expect(await baseWorkBranchOf(second)).toBe("scarn/first-work");
      await complete(second, "scarn/second-work");
    },
  );

  serialTest(
    "the second step has no base work branch after a first step that reported none",
    async () => {
      const { workItemId } = await startPipelineRun(chain("first", "second"));

      const first = await claimOne(workItemId);
      await complete(first, null);

      const second = await claimOne(workItemId);
      expect(await baseWorkBranchOf(second)).toBeNull();
      await complete(second, null);
    },
  );

  const withBaseBranchRun = () => {
    const { stepKey } = requireSetup();
    if (!basedStepKey) {
      throw new Error("Expected setup to complete");
    }
    return startPipelineRun(
      chainedPipelineDocument(`based-pipeline-${crypto.randomUUID()}`, [
        { nodeId: "first", stepKey },
        { nodeId: "second", stepKey: basedStepKey },
      ]),
    );
  };

  serialTest(
    "a second step that sets a base branch gets no base work branch",
    async () => {
      const { workItemId } = await withBaseBranchRun();

      const first = await claimOne(workItemId);
      await complete(first, "scarn/first-work");

      const second = await claimOne(workItemId);
      expect(await baseWorkBranchOf(second)).toBeNull();
      await complete(second, "scarn/second-work");
    },
  );

  serialTest(
    "a yielded run of a step that sets a base branch continues its own branch",
    async () => {
      const { headers } = requireSetup();
      const { workItemId } = await withBaseBranchRun();

      const first = await claimOne(workItemId);
      await complete(first, "scarn/first-work");

      const second = await claimOne(workItemId);
      await unwrapAsync(
        apiClient.api["task-runs"]({ taskRunId: second.taskRunId }).yields.post(
          {
            claimToken: second.claimToken,
            message: "Which one?",
            workBranch: "scarn/second-work",
          },
          { headers },
        ),
      );
      const [task] = await getDb()
        .select({ conversationId: tasks.conversationId })
        .from(taskRuns)
        .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
        .where(eq(taskRuns.id, second.taskRunId));
      const conversationId = parseUuidV7(task?.conversationId ?? "");
      await unwrapAsync(
        apiClient.api
          .conversations({ conversationId })
          .messages.post({ body: "The second one." }, { headers }),
      );

      const continuation = await claimOne(workItemId);
      expect(await baseWorkBranchOf(continuation)).toBe("scarn/second-work");
      await complete(continuation, "scarn/second-work");
    },
  );

  serialTest(
    "a step after a step that reported no branch branches off the nearest earlier work branch",
    async () => {
      const { workItemId } = await startPipelineRun(
        chain("first", "middle", "last"),
      );

      const first = await claimOne(workItemId);
      await complete(first, "scarn/first-work");

      const middle = await claimOne(workItemId);
      expect(await baseWorkBranchOf(middle)).toBe("scarn/first-work");
      await complete(middle, null);

      const last = await claimOne(workItemId);
      expect(await baseWorkBranchOf(last)).toBe("scarn/first-work");
      await complete(last, "scarn/last-work");
    },
  );

  serialTest(
    "a merge of lanes on different work branches has no base work branch and records why",
    async () => {
      const { stepKey } = requireSetup();
      const { executionId, workItemId } = await startPipelineRun({
        schemaVersion: 1,
        key: `base-branch-lanes-${crypto.randomUUID()}`,
        start: { to: "entry" },
        nodes: {
          entry: {
            kind: "step",
            step: stepKey,
            next: {
              routes: [
                {
                  to: "lane",
                  each: { over: "result.items" },
                  args: { item: "item" },
                },
              ],
            },
          },
          lane: {
            kind: "step",
            step: stepKey,
            next: {
              routes: [{ to: "after", partial: true }],
            },
          },
          after: {
            kind: "step",
            step: stepKey,
            next: {
              routes: [{ to: "done" }],
            },
          },
          done: { kind: "succeed" },
        },
      });

      const entry = await claimOne(workItemId);
      await complete(entry, "scarn/entry-work", { items: ["a", "b"] });

      const laneClaims = await claimNext(workItemId, 2);
      for (const [index, claim] of laneClaims.entries()) {
        expect(await baseWorkBranchOf(claim)).toBe("scarn/entry-work");
        await complete(claim, `scarn/lane-${String(index + 1)}`);
      }

      const after = await claimOne(workItemId);
      expect(await baseWorkBranchOf(after)).toBeNull();
      await complete(after, null);

      const execution = await unwrapAsync(
        apiClient.api["pipeline-executions"]({
          pipelineExecutionId: executionId,
        }).get({ headers: requireSetup().headers }),
      );
      const afterVisit = execution.visits.find(
        (visit) => visit.nodeId === "after",
      );
      expect(afterVisit?.routing).toMatchObject({
        notes: [{ kind: "branch_ambiguous" }],
      });
      const notes = (
        afterVisit?.routing as { notes?: Array<{ branches?: string[] }> }
      ).notes;
      expect([...(notes?.[0]?.branches ?? [])].sort()).toEqual([
        "scarn/lane-1",
        "scarn/lane-2",
      ]);
    },
  );

  serialTest("a standalone task has no base work branch", async () => {
    const { projectId, stepDefinitionId, headers } = requireSetup();
    const { run: task } = await unwrapStartedTaskAsync(
      apiClient.api.tasks.post(
        {
          projectId,
          workItemId: await seedWorkItem(projectId),
          stepDefinitionId,
          stepDefinitionVersion: 1,
          inputJson: { ticketId: "standalone" },
          executionTimeoutSeconds: 120,
        },
        { headers },
      ),
    );
    const claims = await unwrapAsync(
      apiClient.api["task-runs"].claims.post(
        {
          projectId,
          workerId: "base-branch-standalone-worker",
          batchSize: 100,
          leaseDurationSeconds: 30,
        },
        { headers },
      ),
    );
    const claim = claims.find((item) => item.task.id === task.id);
    if (!claim) {
      throw new Error("Expected the standalone task to be claimed");
    }

    expect(
      await baseWorkBranchOf({
        taskRunId: claim.task.id,
        claimToken: claim.claimToken,
      }),
    ).toBeNull();
  });
});
