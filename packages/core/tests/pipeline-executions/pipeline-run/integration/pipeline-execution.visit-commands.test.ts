import { beforeAll, describe, expect } from "bun:test";
import type { PipelineDocument } from "@scarn/sdk/contracts/pipeline-document";
import { serialTest } from "tests/utils";
import { chainedPipelineDocument } from "tests/pipeline-definitions/pipeline-test-support";
import { createPipelineRunHarness } from "./pipeline-run-test-support";

describe("pipeline execution visit commands", () => {
  const harness = createPipelineRunHarness("pipeline-run-visit-commands");

  beforeAll(async () => {
    await harness.setUp();
  });

  const chain = (...nodeIds: string[]) =>
    chainedPipelineDocument(
      harness.uniqueKey("visit-commands"),
      nodeIds.map((nodeId) => ({
        nodeId,
        stepKey: harness.requireSetup().stepKey,
      })),
    );

  const decisionDocument = (): PipelineDocument => {
    const { stepKey } = harness.requireSetup();
    return {
      schemaVersion: 1,
      key: harness.uniqueKey("decision"),
      start: { to: "draft" },
      nodes: {
        draft: {
          kind: "step",
          step: stepKey,
          next: {
            routes: [{ to: "review" }],
          },
        },
        review: {
          kind: "wait",
          for: "decision",
          actions: [
            { key: "approve", label: "Approve", body: "optional" },
            { key: "reject", label: "Reject", body: "optional" },
          ],
          next: {
            routes: [
              {
                when: { path: "result.action", op: "equal", value: "approve" },
                to: "publish",
              },
            ],
            otherwise: { to: "rejected" },
          },
        },
        publish: {
          kind: "step",
          step: stepKey,
          next: {
            routes: [{ to: "done" }],
          },
        },
        done: { kind: "succeed" },
        rejected: { kind: "fail", error: "DraftRejected" },
      },
    };
  };

  serialTest(
    "rerunning a finished run's first visit supersedes everything after it and reopens the run",
    async () => {
      const { executionId, workItemId } = await harness.startRun(
        chain("first", "second"),
      );
      const first = await harness.claimOne(workItemId);
      await harness.complete(first, "succeeded");
      await harness.complete(await harness.claimOne(workItemId), "succeeded");
      const finished = await harness.getRun(executionId);
      expect(finished.runStatus).toBe("succeeded");
      const firstVisit = harness.visitOf(finished, "first");

      const rerun = await harness.apiClient.api["pipeline-executions"]({
        pipelineExecutionId: executionId,
      })
        .visits({ visitId: firstVisit.id })
        .rerun.post(undefined, { headers: harness.requireSetup().headers });
      expect(rerun.error).toBeNull();
      expect(rerun.data).toMatchObject({
        runStatus: "active",
        endNodeId: null,
        completedAt: null,
      });

      const reopened = await harness.getRun(executionId);
      const statusesOf = (nodeId: string) =>
        reopened.visits
          .filter((visit) => visit.nodeId === nodeId)
          .map((visit) => visit.status);
      expect(statusesOf("first")).toEqual(["superseded", "active"]);
      expect(statusesOf("second")).toEqual(["superseded"]);
      expect(statusesOf("done")).toEqual(["superseded"]);

      const rerunTaskId = harness.visitOf(reopened, "first").tasks[0]?.taskId;
      if (!rerunTaskId) {
        throw new Error("Expected the rerun to queue a Task");
      }
      expect((await harness.getTaskRun(rerunTaskId)).previousTaskRunId).toBe(
        first.taskId,
      );

      await harness.complete(await harness.claimOne(workItemId), "succeeded");
      const secondAgain = harness.visitOf(
        await harness.getRun(executionId),
        "second",
      );
      expect(secondAgain.status).toBe("active");
      const secondTaskId = secondAgain.tasks[0]?.taskId;
      if (!secondTaskId) {
        throw new Error("Expected a fresh downstream Task");
      }
      expect(
        (await harness.getTaskRun(secondTaskId)).previousTaskRunId,
      ).toBeNull();
    },
  );

  serialTest("a superseded visit can't be rerun", async () => {
    const { executionId, workItemId } = await harness.startRun(chain("only"));
    await harness.complete(await harness.claimOne(workItemId), "succeeded");
    const originalVisitId = harness.visitOf(
      await harness.getRun(executionId),
      "only",
    ).id;
    const routes = harness.visitRoutes(executionId, originalVisitId);
    const headers = harness.requireSetup().headers;
    expect((await routes.rerun.post(undefined, { headers })).error).toBeNull();

    const again = await routes.rerun.post(undefined, { headers });
    expect(again.error?.status).toBe(422);
    expect(again.error?.value).toMatchObject({
      code: "PIPELINE_RUN_INVALID_VISIT_STATE",
    });
  });

  serialTest(
    "sending a message reruns the visit and the new Task's thread carries it",
    async () => {
      const { executionId, workItemId } = await harness.startRun(chain("only"));
      const original = await harness.claimOne(workItemId);
      await harness.complete(original, "succeeded");
      const visit = harness.visitOf(await harness.getRun(executionId), "only");

      const sent = await harness
        .visitRoutes(executionId, visit.id)
        .messages.post(
          { body: "Please also cover the edge case", quoteText: "edge case" },
          { headers: harness.requireSetup().headers },
        );
      expect(sent.error).toBeNull();
      const rerunVisit = harness.visitOf(
        sent.data?.pipelineExecution ?? (await harness.getRun(executionId)),
        "only",
      );
      const rerunTaskId = rerunVisit.tasks[0]?.taskId;
      if (!rerunTaskId) {
        throw new Error("Expected the message rerun to queue a Task");
      }
      const rerunRun = await harness.getTaskRun(rerunTaskId);
      expect(sent.data?.message).toMatchObject({
        taskId: rerunRun.taskId,
        body: "Please also cover the edge case",
        quoteText: "edge case",
      });

      const thread = await harness
        .visitRoutes(executionId, rerunVisit.id)
        .thread.get({ headers: harness.requireSetup().headers });
      expect(thread.data?.runs.map((run) => run.taskRunId)).toEqual([
        original.taskId,
        rerunTaskId,
      ]);
      expect(thread.data?.runs[1]?.messages.map((item) => item.body)).toEqual([
        "Please also cover the edge case",
      ]);
    },
  );

  serialTest(
    "a decision wait parks the run until it is approved, then the run continues",
    async () => {
      const { executionId, workItemId } =
        await harness.startRun(decisionDocument());
      await harness.complete(await harness.claimOne(workItemId), "succeeded");

      const waiting = await harness.getRun(executionId);
      expect(waiting).toMatchObject({
        runStatus: "waiting",
        status: "waiting",
        waitingFor: "decision",
      });
      const review = harness.visitOf(waiting, "review");
      expect(review).toMatchObject({
        nodeKind: "wait",
        status: "waiting",
        waitFor: "decision",
        questions: [],
      });
      expect(await harness.claim(workItemId)).toHaveLength(0);

      const resolved = await harness
        .visitRoutes(executionId, review.id)
        .decision.post(
          { action: "approve", body: "Ship it" },
          { headers: harness.requireSetup().headers },
        );
      expect(resolved.error).toBeNull();
      expect(resolved.data?.runStatus).toBe("active");
      expect(
        harness.visitOf(await harness.getRun(executionId), "review"),
      ).toMatchObject({
        status: "succeeded",
        result: { action: "approve", body: "Ship it" },
      });
      expect(
        harness.visitOf(await harness.getRun(executionId), "review")
          .resolvedByUserId,
      ).not.toBeNull();

      await harness.complete(await harness.claimOne(workItemId), "succeeded");
      expect(await harness.getRun(executionId)).toMatchObject({
        runStatus: "succeeded",
        endNodeId: "done",
      });
    },
  );

  serialTest("rejecting a decision takes the fallback transition", async () => {
    const { executionId, workItemId } =
      await harness.startRun(decisionDocument());
    await harness.complete(await harness.claimOne(workItemId), "succeeded");
    const review = harness.visitOf(await harness.getRun(executionId), "review");

    await harness
      .visitRoutes(executionId, review.id)
      .decision.post(
        { action: "reject" },
        { headers: harness.requireSetup().headers },
      );

    expect(await harness.getRun(executionId)).toMatchObject({
      runStatus: "failed",
      endNodeId: "rejected",
      error: { name: "DraftRejected" },
    });
  });

  serialTest("a visit that isn't waiting can't be decided", async () => {
    const { executionId } = await harness.startRun(decisionDocument());
    const draft = harness.visitOf(await harness.getRun(executionId), "draft");

    const resolved = await harness
      .visitRoutes(executionId, draft.id)
      .decision.post(
        { action: "approve" },
        { headers: harness.requireSetup().headers },
      );
    expect(resolved.data).toBeNull();
    expect(resolved.error?.status).toBe(422);
    expect(resolved.error?.value).toMatchObject({
      code: "PIPELINE_RUN_VISIT_NOT_WAITING",
    });
    expect(
      harness.visitOf(await harness.getRun(executionId), "draft").status,
    ).toBe("active");
  });
});
