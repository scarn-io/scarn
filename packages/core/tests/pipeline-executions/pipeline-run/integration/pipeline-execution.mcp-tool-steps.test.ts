import { beforeAll, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import type { UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { getDb } from "@/lib/db";
import { taskRuns, tasks } from "@/lib/db/schema";
import { serialTest, unwrapAsync } from "tests/utils";
import { chainedPipelineDocument } from "tests/pipeline-definitions/pipeline-test-support";
import {
  createPipelineRunHarness,
  mcpToolCallFixture as toolCallJson,
  type Claim,
} from "./pipeline-run-test-support";

/**
 * A pipeline visit of an `mcp_tool` step queues an `mcp_tool` Task carrying
 * the step's tool call, and the worker context hands that tool call over
 * only for such Tasks.
 */
describe("pipeline execution mcp_tool steps", () => {
  const harness = createPipelineRunHarness("pipeline-run-mcp-tool-steps");
  let mcpToolStepKey = "";

  beforeAll(async () => {
    await harness.setUp();
    mcpToolStepKey = (await harness.createMcpToolStep()).key;
  });

  const workerContextOf = async (claim: Claim) =>
    await unwrapAsync(
      harness.apiClient.api["task-runs"]({ taskRunId: claim.taskId })[
        "worker-context"
      ].post(
        { claimToken: claim.claimToken },
        { headers: harness.requireSetup().headers },
      ),
    );

  const taskOfRun = async (taskRunId: UuidV7) => {
    const [row] = await getDb()
      .select({
        kind: tasks.kind,
        prompt: tasks.prompt,
        entrypointJson: tasks.entrypointJson,
        toolCallJson: tasks.toolCallJson,
      })
      .from(taskRuns)
      .innerJoin(tasks, eq(tasks.id, taskRuns.taskId))
      .where(eq(taskRuns.id, taskRunId));
    return row;
  };

  serialTest(
    "queues an mcp_tool Task with the step's tool call, and the worker context carries it",
    async () => {
      const { workItemId } = await harness.startRun(
        chainedPipelineDocument(harness.uniqueKey("mcp-tool"), [
          { nodeId: "search", stepKey: mcpToolStepKey },
          { nodeId: "summarise", stepKey: harness.requireSetup().stepKey },
        ]),
      );

      const search = await harness.claimOne(workItemId);
      expect(await taskOfRun(search.taskId)).toEqual({
        kind: "mcp_tool",
        prompt: null,
        entrypointJson: null,
        toolCallJson,
      });
      const searchContext = await workerContextOf(search);
      expect(searchContext.task).toMatchObject({
        kind: "mcp_tool",
        prompt: null,
        entrypointJson: null,
        toolCall: toolCallJson,
      });

      await harness.complete(search, "succeeded", { hits: [] });
      const summarise = await harness.claimOne(workItemId);
      const summariseContext = await workerContextOf(summarise);
      expect(summariseContext.task.kind).toBe("agent");
      expect(summariseContext.task.toolCall).toBeNull();
    },
    30_000,
  );

  const startSearchRun = async () => {
    const { executionId, workItemId } = await harness.startRun(
      chainedPipelineDocument(harness.uniqueKey("mcp-tool-rules"), [
        { nodeId: "search", stepKey: mcpToolStepKey },
      ]),
    );
    return { executionId, workItemId };
  };

  serialTest("a visit of an mcp_tool step doesn't take messages", async () => {
    const { executionId, workItemId } = await startSearchRun();
    await harness.complete(await harness.claimOne(workItemId), "succeeded", {
      hits: [],
    });
    const before = await harness.getRun(executionId);
    const visit = harness.visitOf(before, "search");

    const sent = await harness
      .visitRoutes(executionId, visit.id)
      .messages.post(
        { body: "Search the archive too" },
        { headers: harness.requireSetup().headers },
      );

    expect(sent.error?.status).toBe(422);
    expect(sent.error?.value).toMatchObject({
      code: "PIPELINE_RUN_MESSAGE_CODE_STEP",
      detail: expect.stringContaining("MCP tool steps") as string,
    });
    expect(await harness.getRun(executionId)).toEqual(before);
  });

  serialTest(
    "stopping an mcp_tool step's Task cancels the pipeline execution",
    async () => {
      const { executionId } = await startSearchRun();
      const taskRunId = harness.visitOf(
        await harness.getRun(executionId),
        "search",
      ).tasks[0]?.taskId;
      if (!taskRunId) {
        throw new Error("Expected the step's run");
      }
      const { taskId } = await harness.getTaskRun(taskRunId);

      const stopped = await harness.apiClient.api
        .tasks({ taskId })
        .cancel.post(undefined, { headers: harness.requireSetup().headers });

      expect(stopped.error).toBeNull();
      expect((await harness.getRun(executionId)).runStatus).toBe("cancelled");
      const [task] = await getDb()
        .select({ kind: tasks.kind, status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, taskId));
      expect(task).toEqual({ kind: "mcp_tool", status: "cancelled" });
    },
  );
});
