import { beforeAll, describe, expect } from "bun:test";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import { serialTest } from "tests/utils";
import { chainedPipelineDocument } from "tests/pipeline-definitions/pipeline-test-support";
import { recordingWorkNotifier } from "tests/tasks/task-run/recording-work-notifier";
import { createPipelineRunHarness } from "./pipeline-run-test-support";

describe("pipeline execution lifecycle", () => {
  const harness = createPipelineRunHarness("pipeline-run-lifecycle");

  beforeAll(async () => {
    await harness.setUp();
  });

  const chain = (...nodeIds: string[]) =>
    chainedPipelineDocument(
      harness.uniqueKey("lifecycle"),
      nodeIds.map((nodeId) => ({
        nodeId,
        stepKey: harness.requireSetup().stepKey,
      })),
    );

  serialTest(
    "a two-step run is queued, then running, then advances and succeeds",
    async () => {
      harness.setTime("2026-06-01T09:00:00.000Z");
      const { execution, executionId, workItemId } = await harness.startRun(
        chain("first", "second"),
      );
      expect(execution).toMatchObject({
        runStatus: "active",
        status: "queued",
        endNodeId: null,
      });
      expect(execution.visits.map((visit) => visit.nodeId)).toEqual(["first"]);

      const first = await harness.claimOne(workItemId);
      expect((await harness.getRun(executionId)).status).toBe("running");
      await harness.complete(first, "succeeded", { summary: "first done" });

      const afterFirst = await harness.getRun(executionId);
      expect(harness.visitOf(afterFirst, "first")).toMatchObject({
        status: "succeeded",
        result: { summary: "first done" },
        resultTaskId: first.taskId,
      });
      expect(harness.visitOf(afterFirst, "second")).toMatchObject({
        status: "active",
        fromVisitId: harness.visitOf(afterFirst, "first").id,
        transition: { kind: "route", index: 0 },
      });
      expect(afterFirst.status).toBe("queued");

      const second = await harness.claimOne(workItemId);
      await harness.complete(second, "succeeded");

      const finished = await harness.getRun(executionId);
      expect(finished).toMatchObject({
        runStatus: "succeeded",
        status: "succeeded",
        endNodeId: "done",
        error: null,
      });
      expect(finished.completedAt).toBe("2026-06-01T09:00:00.000Z");
    },
  );

  serialTest("a failed step with no retry or catch fails the run", async () => {
    const { executionId, workItemId } = await harness.startRun(chain("only"));

    const only = await harness.claimOne(workItemId);
    await harness.complete(only, "failed", null, { message: "boom" });

    const failed = await harness.getRun(executionId);
    expect(failed).toMatchObject({
      runStatus: "failed",
      status: "failed",
      endNodeId: null,
      error: { name: "Scarn.StepFailed", message: "boom" },
    });
    expect(harness.visitOf(failed, "only")).toMatchObject({
      status: "failed",
      error: { name: "Scarn.StepFailed" },
    });
  });

  serialTest(
    "a retried step queues a second attempt that continues the first",
    async () => {
      const { stepKey } = harness.requireSetup();
      const { executionId, workItemId } = await harness.startRun({
        schemaVersion: 1,
        key: harness.uniqueKey("retry"),
        start: { to: "flaky" },
        nodes: {
          flaky: {
            kind: "step",
            step: stepKey,
            retry: [{ on: ["Scarn.StepFailed"], maxAttempts: 1 }],
            next: {
              routes: [{ to: "done" }],
            },
          },
          done: { kind: "succeed" },
        },
      });

      const firstAttempt = await harness.claimOne(workItemId);
      await harness.complete(firstAttempt, "failed", null, {
        message: "flaked",
      });

      const retrying = await harness.getRun(executionId);
      const visit = harness.visitOf(retrying, "flaky");
      expect(retrying.runStatus).toBe("active");
      expect(visit.status).toBe("active");
      expect(visit.tasks.map((task) => task.attemptNumber)).toEqual([1, 2]);
      const secondTaskId = visit.tasks[1]?.taskId;
      if (!secondTaskId) {
        throw new Error("Expected a second attempt");
      }
      expect((await harness.getTaskRun(secondTaskId)).previousTaskRunId).toBe(
        firstAttempt.taskId,
      );

      const secondAttempt = await harness.claimOne(workItemId);
      expect(secondAttempt.taskId).toBe(secondTaskId);
      await harness.complete(secondAttempt, "succeeded");
      expect((await harness.getRun(executionId)).runStatus).toBe("succeeded");
    },
  );

  serialTest("a retry that runs out of attempts fails the run", async () => {
    const { stepKey } = harness.requireSetup();
    const { executionId, workItemId } = await harness.startRun({
      schemaVersion: 1,
      key: harness.uniqueKey("retry-exhausted"),
      start: { to: "flaky" },
      nodes: {
        flaky: {
          kind: "step",
          step: stepKey,
          retry: [{ on: ["Scarn.StepFailed"], maxAttempts: 1 }],
          next: {
            routes: [{ to: "done" }],
          },
        },
        done: { kind: "succeed" },
      },
    });

    await harness.complete(await harness.claimOne(workItemId), "failed");
    await harness.complete(await harness.claimOne(workItemId), "failed");

    const failed = await harness.getRun(executionId);
    expect(failed.runStatus).toBe("failed");
    expect(harness.visitOf(failed, "flaky").tasks).toHaveLength(2);
  });

  serialTest(
    "a caught error moves the run to the catch target with the error as input",
    async () => {
      const { stepKey } = harness.requireSetup();
      const { executionId, workItemId } = await harness.startRun({
        schemaVersion: 1,
        key: harness.uniqueKey("catch"),
        start: { to: "risky" },
        nodes: {
          risky: {
            kind: "step",
            step: stepKey,
            catch: [
              {
                on: ["Scarn.All"],
                to: "recover",
                args: { reason: "error.message" },
              },
            ],
            next: {
              routes: [{ to: "done" }],
            },
          },
          recover: {
            kind: "step",
            step: stepKey,
            next: {
              routes: [{ to: "done" }],
            },
          },
          done: { kind: "succeed" },
        },
      });

      await harness.complete(
        await harness.claimOne(workItemId),
        "failed",
        null,
        { message: "risky broke" },
      );

      const recovering = await harness.getRun(executionId);
      expect(recovering.runStatus).toBe("active");
      expect(harness.visitOf(recovering, "recover")).toMatchObject({
        status: "active",
        transition: { kind: "catch", index: 0 },
        input: { reason: "risky broke" },
      });

      await harness.complete(await harness.claimOne(workItemId), "succeeded");
      expect(await harness.getRun(executionId)).toMatchObject({
        runStatus: "succeeded",
        endNodeId: "done",
      });
    },
  );

  serialTest("a fail node ends the run with its named error", async () => {
    const { stepKey } = harness.requireSetup();
    const { executionId, workItemId } = await harness.startRun({
      schemaVersion: 1,
      key: harness.uniqueKey("fail-node"),
      start: { to: "check" },
      nodes: {
        check: {
          kind: "step",
          step: stepKey,
          next: {
            routes: [
              {
                when: { path: "result.ok", op: "equal", value: true },
                to: "done",
              },
            ],
            otherwise: { to: "rejected" },
          },
        },
        done: { kind: "succeed" },
        rejected: { kind: "fail", error: "CheckRejected" },
      },
    });

    await harness.complete(await harness.claimOne(workItemId), "succeeded", {
      ok: false,
    });

    expect(await harness.getRun(executionId)).toMatchObject({
      runStatus: "failed",
      endNodeId: "rejected",
      error: { name: "CheckRejected" },
    });
  });

  serialTest(
    "a Task that outlives its node's timeout fails the run with Scarn.Timeout",
    async () => {
      const { stepKey } = harness.requireSetup();
      harness.setTime("2026-06-01T10:00:00.000Z");
      const { executionId, workItemId } = await harness.startRun({
        schemaVersion: 1,
        key: harness.uniqueKey("timeout"),
        start: { to: "slow" },
        nodes: {
          slow: {
            kind: "step",
            step: stepKey,
            timeoutSeconds: 15,
            next: {
              routes: [{ to: "done" }],
            },
          },
          done: { kind: "succeed" },
        },
      });
      const slow = await harness.claimOne(workItemId);

      harness.setTime("2026-06-01T10:00:16.000Z");
      const heartbeat = await harness.apiClient.api["task-runs"]({
        taskRunId: slow.taskId,
      }).heartbeat.put(
        { claimToken: slow.claimToken, leaseDurationSeconds: 30 },
        { headers: harness.requireSetup().headers },
      );
      expect(heartbeat.data?.status).toBe("timeout");

      const failed = await harness.getRun(executionId);
      expect(failed).toMatchObject({
        runStatus: "failed",
        error: { name: "Scarn.Timeout" },
        completedAt: "2026-06-01T10:00:16.000Z",
      });
      expect(harness.visitOf(failed, "slow").tasks[0]?.status).toBe("timeout");
    },
  );

  serialTest(
    "a Task whose lease lapses is abandoned and fails the run with Scarn.HeartbeatTimeout",
    async () => {
      harness.setTime("2026-06-01T11:00:00.000Z");
      const { executionId, workItemId } = await harness.startRun(
        chain("quiet"),
      );
      const quiet = await harness.claimOne(workItemId, 30);

      harness.setTime("2026-06-01T11:00:31.000Z");
      expect(await harness.claim(workItemId)).toHaveLength(0);

      expect((await harness.getTaskRun(quiet.taskId)).status).toBe("abandoned");
      expect(await harness.getRun(executionId)).toMatchObject({
        runStatus: "failed",
        error: { name: "Scarn.HeartbeatTimeout" },
      });
    },
  );

  serialTest(
    "an abandoned Task with a retry queues a fresh attempt",
    async () => {
      const { stepKey } = harness.requireSetup();
      harness.setTime("2026-06-01T12:00:00.000Z");
      const document: PipelineDocument = {
        schemaVersion: 1,
        key: harness.uniqueKey("abandon-retry"),
        start: { to: "quiet" },
        nodes: {
          quiet: {
            kind: "step",
            step: stepKey,
            retry: [{ on: ["Scarn.HeartbeatTimeout"], maxAttempts: 1 }],
            next: {
              routes: [{ to: "done" }],
            },
          },
          done: { kind: "succeed" },
        },
      };
      const { executionId, workItemId } = await harness.startRun(document);
      const firstAttempt = await harness.claimOne(workItemId, 30);

      harness.setTime("2026-06-01T12:00:31.000Z");
      const [secondAttempt] = await harness.claim(workItemId);
      if (!secondAttempt) {
        throw new Error("Expected the retry to be claimable");
      }
      expect(secondAttempt.taskId).not.toBe(firstAttempt.taskId);
      await harness.complete(secondAttempt, "succeeded");

      expect((await harness.getRun(executionId)).runStatus).toBe("succeeded");
    },
  );

  serialTest(
    "a start that binds workItem.description passes the work item's description to the first Task",
    async () => {
      const document = chain("first");
      const { execution } = await harness.startRun({
        ...document,
        start: {
          ...document.start,
          args: { description: "workItem.description" },
        },
      });
      const taskId = harness.visitOf(execution, "first").tasks[0]?.taskId;
      if (!taskId) {
        throw new Error("Expected a queued Task");
      }

      expect((await harness.getTaskRun(taskId)).inputJson).toMatchObject({
        description: "Work item seeded for a task claims test",
      });
    },
  );

  serialTest(
    "cancelling a run cancels its open visit and its queued Task",
    async () => {
      const { executionId } = await harness.startRun(chain("first", "second"));
      const queuedTaskId = harness.visitOf(
        await harness.getRun(executionId),
        "first",
      ).tasks[0]?.taskId;
      if (!queuedTaskId) {
        throw new Error("Expected a queued Task");
      }

      const cancelled = await harness.apiClient.api["pipeline-executions"]({
        pipelineExecutionId: executionId,
      }).cancel.put(undefined, { headers: harness.requireSetup().headers });
      expect(cancelled.data).toMatchObject({
        runStatus: "cancelled",
        status: "cancelled",
      });
      expect(
        harness.visitOf(await harness.getRun(executionId), "first"),
      ).toMatchObject({ status: "cancelled" });
      expect((await harness.getTaskRun(queuedTaskId)).status).toBe("cancelled");
    },
  );
});

describe("pipeline execution lifecycle: work notifications", () => {
  const { workNotifier, enqueued } = recordingWorkNotifier();
  const harness = createPipelineRunHarness("pipeline-run-notify", {
    workNotifier,
  });

  beforeAll(async () => {
    await harness.setUp();
  });

  serialTest(
    "starting a run and advancing it to the next step notify the project",
    async () => {
      const { projectId, stepKey } = harness.requireSetup();
      const { workItemId } = await harness.startRun(
        chainedPipelineDocument(harness.uniqueKey("notify"), [
          { nodeId: "first", stepKey },
          { nodeId: "second", stepKey },
        ]),
      );
      expect(enqueued).toEqual([projectId]);

      await harness.complete(await harness.claimOne(workItemId), "succeeded");

      expect(enqueued).toEqual([projectId, projectId]);
    },
  );
});
