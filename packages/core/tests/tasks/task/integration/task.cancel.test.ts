import { beforeAll, describe, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { conversations, taskRuns, tasks } from "@/lib/db/schema";
import { parseUuidV7, type UuidV7 } from "@scarn/core/common/contracts/uuid-v7";
import { concurrentTest, serialTest, unwrapAsync } from "tests/utils";
import { createQuestionHarness } from "tests/pipeline-executions/pipeline-run/integration/question-test-support";
import { mcpToolCallFixture } from "tests/pipeline-executions/pipeline-run/integration/pipeline-run-test-support";
import { createHandOverHarness } from "./hand-over-test-support";

describe("stopping a standalone Task", () => {
  const { apiClient, requireSetup, seedItem, startTask, loadTask, handedOver } =
    createHandOverHarness();

  const cancel = (taskId: UuidV7) =>
    apiClient.api.tasks({ taskId }).cancel.post(undefined, {
      headers: requireSetup().headers,
    });

  concurrentTest("a queued Task's run is cancelled with it", async () => {
    const workItemId = await seedItem();
    const { taskId } = await startTask(workItemId, "conversation");

    expect(await unwrapAsync(cancel(taskId))).toEqual({ taskId });

    expect((await loadTask(taskId))?.status).toBe("cancelled");
    const runs = await unwrapAsync(
      apiClient.api.tasks({ taskId }).runs.get({
        headers: requireSetup().headers,
      }),
    );
    expect(runs.map((run) => run.status)).toEqual(["cancelled"]);
  });

  concurrentTest(
    "a Task waiting for a person ends cancelled and closes its conversation",
    async () => {
      const { taskId, conversationId } = await handedOver("conversation");

      await unwrapAsync(cancel(taskId));

      expect((await loadTask(taskId))?.status).toBe("cancelled");
      const [conversation] = await getDb()
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      expect(conversation?.status).toBe("closed");
    },
  );

  concurrentTest("a Task that already ended is refused", async () => {
    const workItemId = await seedItem();
    const { taskId } = await startTask(workItemId, "conversation");
    await unwrapAsync(cancel(taskId));

    const again = await cancel(taskId);

    expect(again.status).toBe(422);
    expect(again.error?.value).toMatchObject({ code: "TASK_ALREADY_ENDED" });
  });

  concurrentTest("a code Task is refused", async () => {
    const workItemId = await seedItem();
    const { taskId } = await startTask(workItemId, "conversation");
    await getDb()
      .update(tasks)
      .set({
        kind: "code",
        prompt: null,
        entrypointJson: { sourceFile: "steps/run.ts" },
      })
      .where(eq(tasks.id, taskId));

    const refused = await cancel(taskId);

    expect(refused.status).toBe(422);
    expect(refused.error?.value).toMatchObject({
      code: "TASK_CANCEL_CODE_TASK",
    });
    expect((await loadTask(taskId))?.status).toBe("queued");
  });

  concurrentTest(
    "an MCP tool Task is cancelled like an agent Task",
    async () => {
      const workItemId = await seedItem();
      const { taskId } = await startTask(workItemId, "conversation");
      await getDb()
        .update(tasks)
        .set({
          kind: "mcp_tool",
          prompt: null,
          toolCallJson: mcpToolCallFixture,
        })
        .where(eq(tasks.id, taskId));

      expect(await unwrapAsync(cancel(taskId))).toEqual({ taskId });

      expect((await loadTask(taskId))?.status).toBe("cancelled");
      const runs = await unwrapAsync(
        apiClient.api.tasks({ taskId }).runs.get({
          headers: requireSetup().headers,
        }),
      );
      expect(runs.map((run) => run.status)).toEqual(["cancelled"]);
    },
  );

  concurrentTest("an unknown Task is not found", async () => {
    const missing = await cancel(
      parseUuidV7("01900000-0000-7000-8000-000000000000"),
    );
    expect(missing.status).toBe(404);
  });
});

describe("stopping a pipeline step's Task", () => {
  const { harness, headers, startWaitingRun, memberWith } =
    createQuestionHarness("task-cancel");

  beforeAll(async () => {
    await harness.setUp();
  });

  const cancel = (taskId: UuidV7, authHeaders = headers()) =>
    harness.apiClient.api.tasks({ taskId }).cancel.post(undefined, {
      headers: authHeaders,
    });

  const taskOfRun = async (taskRunId: string | undefined) => {
    if (!taskRunId) {
      throw new Error("Expected the step's run");
    }
    const [run] = await getDb()
      .select({ taskId: taskRuns.taskId })
      .from(taskRuns)
      .where(eq(taskRuns.id, taskRunId));
    if (!run) {
      throw new Error("Expected the run's Task");
    }
    return parseUuidV7(run.taskId);
  };

  const startStepTask = async () => {
    const { executionId, workItemId } = await harness.startRun({
      schemaVersion: 1,
      key: harness.uniqueKey("cancel"),
      start: { to: "only" },
      nodes: {
        only: {
          kind: "step",
          step: harness.requireSetup().stepKey,
          next: { routes: [{ to: "done" }] },
        },
        done: { kind: "succeed" },
      },
    });
    const taskId = await taskOfRun(
      harness.visitOf(await harness.getRun(executionId), "only").tasks[0]
        ?.taskId,
    );
    return { executionId, workItemId: parseUuidV7(workItemId), taskId };
  };

  serialTest("cancels the whole pipeline execution", async () => {
    const { executionId, taskId } = await startStepTask();

    expect(await unwrapAsync(cancel(taskId))).toEqual({ taskId });

    const execution = await harness.getRun(executionId);
    expect(execution.runStatus).toBe("cancelled");
    const [task] = await getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId));
    expect(task?.status).toBe("cancelled");
  });

  serialTest("needs executions:write", async () => {
    const { executionId, taskId } = await startStepTask();
    const reader = await memberWith("read");

    const refused = await cancel(taskId, reader);

    expect(refused.status).toBe(403);
    expect((await harness.getRun(executionId)).runStatus).toBe("active");
  });

  serialTest("a step Task that already succeeded is refused", async () => {
    const { executionId } = await startWaitingRun();
    const taskId = await taskOfRun(
      harness
        .visitOf(await harness.getRun(executionId), "evaluate")
        .tasks.at(-1)?.taskId,
    );

    const refused = await cancel(taskId);

    expect(refused.status).toBe(422);
    expect(refused.error?.value).toMatchObject({ code: "TASK_ALREADY_ENDED" });
    expect((await harness.getRun(executionId)).runStatus).toBe("waiting");
  });
});
